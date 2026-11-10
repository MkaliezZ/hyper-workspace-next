"""Translate local OCR output into the product's page protocol."""
from html.parser import HTMLParser
import math
from pathlib import Path

import cv2
import numpy as np
from rapid_layout import ModelType as LayoutType, RapidLayout, RapidLayoutInput
from rapid_table import ModelType as TableType, RapidTable, RapidTableInput
from rapidocr import RapidOCR

from page import InvalidPage, open_page


THREADS = {"intra_op_num_threads": 2, "inter_op_num_threads": 1}
TEXT_MODELS = {
    "Det": "PP-OCRv6_det_small.onnx",
    "Rec": "PP-OCRv6_rec_small.onnx",
    "Cls": "ch_ppocr_mobile_v2.0_cls_mobile.onnx",
}


class TableCells(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.cells = []
        self.current = None

    def handle_starttag(self, tag, attrs):
        if tag in {"td", "th"}:
            self.current = []

    def handle_endtag(self, tag):
        if tag in {"td", "th"} and self.current is not None:
            self.cells.append(" ".join("".join(self.current).split()))
            self.current = None

    def handle_data(self, data):
        if self.current is not None:
            self.current.append(data)


def table_text(html, positions):
    parsed = TableCells()
    parsed.feed(html)
    parsed.close()
    if not parsed.cells or len(parsed.cells) != len(positions):
        return ""
    if any(not 0 <= y1 <= y2 < 100 or not 0 <= x1 <= x2 < 100
           for y1, y2, x1, x2 in positions):
        return ""
    height = max(int(pos[1]) for pos in positions) + 1
    width = max(int(pos[3]) for pos in positions) + 1
    grid = [[""] * width for _ in range(height)]
    for text, (row, _, column, _) in zip(parsed.cells, positions):
        grid[int(row)][int(column)] = text
    return "\n".join("\t".join(row) for row in grid) if any(parsed.cells) else ""


def page_bounds(points, width, height, pad=0):
    left, top, right, bottom = (float(point) for point in points)
    if not all(math.isfinite(value) for value in (left, top, right, bottom)):
        return None
    box = (max(0, math.floor(left) - pad), max(0, math.floor(top) - pad),
           min(width, math.ceil(right) + pad), min(height, math.ceil(bottom) + pad))
    return box if box[2] > box[0] and box[3] > box[1] else None


def contains_center(region, box):
    x = (box[0] + box[2]) / 2
    y = (box[1] + box[3]) / 2
    return region[0] <= x <= region[2] and region[1] <= y <= region[3]


class Recognizer:
    def __init__(self, models: Path):
        params = {f"EngineConfig.onnxruntime.{key}": value for key, value in THREADS.items()}
        params.update({f"{section}.model_path": str(models / name)
                       for section, name in TEXT_MODELS.items()})
        cv2.setNumThreads(1)
        self.text = RapidOCR(params=params)
        self.layout = RapidLayout(RapidLayoutInput(
            model_type=LayoutType.PP_LAYOUT_CDLA,
            model_dir_or_path=models / "layout_cdla.onnx",
            engine_cfg=THREADS,
        ))
        self.table = RapidTable(RapidTableInput(
            model_type=TableType.SLANETPLUS,
            model_dir_or_path=models / "slanet-plus.onnx",
            engine_cfg=THREADS,
            ocr_params=params,
        ))

    def recognize(self, content: bytes, mime: str, page: int):
        image = open_page(content, mime, page)
        width, height = image.size
        raster = cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2BGR)
        lines = self.text(raster)
        layout = self.layout(raster)
        regions = []
        if layout.boxes is not None:
            for coords, kind in zip(layout.boxes, layout.class_names):
                bounds = page_bounds(coords, width, height, pad=10 if kind == "table" else 0)
                if bounds:
                    regions.append((kind, bounds))

        blocks = []
        recognized_tables = []
        for bounds in [box for kind, box in regions if kind == "table"][:4]:
            left, top, right, bottom = bounds
            crop = np.ascontiguousarray(raster[top:bottom, left:right])
            text = self.text(crop)
            if text.boxes is None or not text.txts:
                continue
            parsed = self.table(crop, ocr_results=[(text.boxes, text.txts, text.scores)])
            if not parsed.pred_htmls:
                continue
            grid = table_text(parsed.pred_htmls[0], parsed.logic_points[0])
            if grid and len(grid.encode("utf-16-le")) <= 24_000:
                blocks.append(dict(kind="table", bounds=bounds, confidence=None, text=grid))
                recognized_tables.append(bounds)

        titles = [box for kind, box in regions if kind == "title"]
        if lines.boxes is not None:
            for polygon, text, confidence in zip(lines.boxes, lines.txts, lines.scores):
                xs, ys = polygon[:, 0], polygon[:, 1]
                bounds = page_bounds((min(xs), min(ys), max(xs), max(ys)), width, height)
                score = float(confidence)
                if not bounds or not text.strip() or not math.isfinite(score):
                    continue
                if any(contains_center(region, bounds) for region in recognized_tables):
                    continue
                kind = "title" if any(contains_center(region, bounds) for region in titles) else "text"
                blocks.append(dict(kind=kind, bounds=bounds, confidence=max(0.0, min(score, 1.0)), text=text))

        lengths = [len(block["text"].encode("utf-16-le")) // 2 for block in blocks]
        if len(blocks) > 300 or sum(lengths) > 120_000 or any(length > 12_000 for length in lengths):
            raise InvalidPage("Recognition exceeded page output limits")
        blocks.sort(key=lambda block: (block["bounds"][1], block["bounds"][0]))
        return {"width": width, "height": height, "blocks": blocks}
