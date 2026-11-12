"""Bounded, local worksheet SUM pivots; package inspection never edits OOXML."""
import io
import posixpath
import zipfile
from xml.etree import ElementTree as ET

from validation import MAX_CELLS, address, require

MAIN = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"


def bounds(ref):
    pieces = ref.replace("$", "").split(":")
    require(len(pieces) in (1, 2), "unsupported_pivot_range")
    first, last = address(pieces[0]), address(pieces[-1])
    require(first[0] <= last[0] and first[1] <= last[1]
            and (last[0]-first[0]+1)*(last[1]-first[1]+1) <= MAX_CELLS, "unsupported_pivot_range")
    return (*first, *last)


def features(content):
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        names = archive.namelist()
        parts = {name for name in names if name.startswith("xl/pivotTables/") and name.endswith(".xml")}
        types = ET.fromstring(archive.read("[Content_Types].xml"))
        connections = "xl/connections.xml" in names or any(item.get("ContentType", "").endswith(".connections+xml") for item in types)
        parts.update(item.get("PartName", "").lstrip("/") for item in types
                     if item.get("ContentType", "").endswith(".pivotTable+xml"))
        # Relationship/content-type discovery also covers legal relocated parts;
        # a changed ZIP filename must not bypass the capability guard.
        for name in names:
            if name.endswith(".rels"):
                base = posixpath.dirname(posixpath.dirname(name))
                for rel in ET.fromstring(archive.read(name)):
                    connections |= rel.get("Type", "").endswith("/connections")
                    if rel.get("Type", "").endswith("/pivotTable"):
                        require(rel.get("TargetMode") != "External", "unsupported_pivot_source")
                        target = rel.get("Target", "")
                        parts.add(target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join(base, target)))
        parts = sorted(parts)
        if not parts:
            return []
        require(len(parts) == 1, "unsupported_pivot_layout")
        require(not connections, "unsupported_pivot_source")

        def xml(path):
            require(path in names, "unsupported_pivot_source")
            return ET.fromstring(archive.read(path))

        def relationships(path):
            relpath = posixpath.join(posixpath.dirname(path), "_rels", posixpath.basename(path)+".rels")
            if relpath not in names:
                return {}
            result = {}
            for rel in xml(relpath):
                if rel.get("TargetMode") != "External":
                    target = rel.get("Target", "")
                    result[rel.get("Id")] = posixpath.normpath(posixpath.join(posixpath.dirname(path), target)) if not target.startswith("/") else target.lstrip("/")
            return result

        workbook = xml("xl/workbook.xml")
        wb_rels = relationships("xl/workbook.xml")
        sheets = list(workbook.find(MAIN+"sheets"))
        cache_nodes = workbook.find(MAIN+"pivotCaches")
        require(cache_nodes is not None and len(cache_nodes) == 1, "unsupported_pivot_source")
        cache_node = cache_nodes[0]
        cache_path = wb_rels.get(cache_node.get(REL), "")
        cache = xml(cache_path)
        pivot = xml(parts[0])
        require(pivot.tag == MAIN+"pivotTableDefinition", "unsupported_pivot_layout")
        require(pivot.get("grandTotalCaption") is None, "unsupported_pivot_caption")
        require(not any("caption" in key.lower() and key != "dataCaption" for key in pivot.attrib)
                and pivot.get("dataCaption", "Values") == "Values", "unsupported_pivot_caption")
        require(pivot.get("cacheId") == cache_node.get("cacheId"), "unsupported_pivot_source")
        source = cache.find(MAIN+"cacheSource")
        require(source is not None and source.get("type") == "worksheet", "unsupported_pivot_source")
        worksheet = source.find(MAIN+"worksheetSource")
        require(worksheet is not None and worksheet.get("sheet") is not None and worksheet.get("ref")
                and not worksheet.get("name") and not worksheet.get(REL), "unsupported_pivot_source")
        source_indexes = [i for i, sheet in enumerate(sheets) if sheet.get("name") == worksheet.get("sheet")]
        require(len(source_indexes) == 1, "unsupported_pivot_source")
        source_index = source_indexes[0]
        source_bounds = bounds(worksheet.get("ref"))
        width = source_bounds[2]-source_bounds[0]+1
        require(source_bounds[3] > source_bounds[1], "unsupported_pivot_range")
        fields = cache.find(MAIN+"cacheFields")
        require(fields is not None and len(fields) == width, "unsupported_pivot_source")
        for field in fields:
            require(not any("caption" in key.lower() for key in field.attrib), "unsupported_pivot_caption")
            require(not field.get("formula") and field.find(MAIN+"fieldGroup") is None, "unsupported_pivot_layout")
        for tag in ("colFields", "pageFields", "filters", "formats", "conditionalFormats", "extLst"):
            element = pivot.find(MAIN+tag)
            require(element is None or len(element) == 0, "unsupported_pivot_layout")
        for tag in ("calculatedItems", "calculatedMembers", "cacheHierarchies", "extLst"):
            require(cache.find(MAIN+tag) is None, "unsupported_pivot_layout")
        row_fields, data_fields = pivot.find(MAIN+"rowFields"), pivot.find(MAIN+"dataFields")
        require(row_fields is not None and len(row_fields) == 1 and data_fields is not None and len(data_fields) == 1,
                "unsupported_pivot_layout")
        row, data = int(row_fields[0].get("x", "-1")), int(data_fields[0].get("fld", "-1"))
        number_formats = {"0": "General"}
        if "xl/styles.xml" in names:
            number_formats.update({item.get("numFmtId"): item.get("formatCode")
                                   for item in xml("xl/styles.xml").findall(MAIN+"numFmts/"+MAIN+"numFmt")})
        require(0 <= row < width and 0 <= data < width and row != data
                and data_fields[0].get("subtotal", "sum") == "sum"
                and data_fields[0].get("showDataAs", "normal") == "normal"
                and number_formats.get(data_fields[0].get("numFmtId", "0")) == "General", "unsupported_pivot_aggregation")
        pivot_fields = pivot.find(MAIN+"pivotFields")
        require(pivot_fields is not None and len(pivot_fields) == width, "unsupported_pivot_layout")
        for field in pivot_fields:
            require(not any("caption" in key.lower() for key in field.attrib), "unsupported_pivot_caption")
            require(field.get("name") is None and field.find(MAIN+"autoSortScope") is None, "unsupported_pivot_layout")
            require(field.get("autoShow", "0") in ("0", "false") and field.get("sortType", "manual") == "manual"
                    and field.get("defaultSubtotal", "1") in ("1", "true")
                    and all(value in ("0", "false") for key, value in field.attrib.items()
                            if key.endswith("Subtotal") and key != "defaultSubtotal"), "unsupported_pivot_layout")
            for item in field.findall(MAIN+"items/"+MAIN+"item"):
                require(item.get("n") is None and item.get("h", "0") in ("0", "false"), "unsupported_pivot_layout")
        output_indexes = []
        for index, sheet in enumerate(sheets):
            path = wb_rels.get(sheet.get(REL), "")
            xml(path)
            rels = relationships(path)
            if parts[0] in rels.values():
                output_indexes.append(index)
        require(len(output_indexes) == 1 and output_indexes[0] != source_index, "unsupported_pivot_source")
        location = pivot.find(MAIN+"location")
        require(location is not None, "unsupported_pivot_layout")
        output_bounds = bounds(location.get("ref", ""))
        require(output_bounds[2]-output_bounds[0] == 1 and pivot.get("rowGrandTotals", "1") in ("1", "true"),
                "unsupported_pivot_layout")
        records_path = relationships(cache_path).get(cache.get(REL), "")
        require(records_path in names, "unsupported_pivot_cache")
        return [{"name": pivot.get("name"), "sourceSheet": source_index, "sourceName": worksheet.get("sheet"),
                 "sourceRef": worksheet.get("ref"), "sourceBounds": source_bounds, "outputSheet": output_indexes[0],
                 "outputBounds": output_bounds, "rowField": row, "dataField": data,
                 "dataName": data_fields[0].get("name"), "dataCaption": pivot.get("dataCaption", "Values"),
                 "fieldNames": [field.get("name") for field in fields],
                 "cachePath": cache_path, "recordsPath": records_path}]


def signature(items):
    return [{key: value for key, value in item.items() if key not in ("cachePath", "recordsPath")} for item in items]


def cache_records(content, feature):
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        cache = ET.fromstring(archive.read(feature["cachePath"]))
        fields = list(cache.find(MAIN+"cacheFields"))
        records = ET.fromstring(archive.read(feature["recordsPath"]))
        require(len(records) <= 1000, "unsupported_pivot_cache")
        result = []
        for record in records:
            require(len(record) == len(fields), "unsupported_pivot_cache")
            values = []
            for column, item in enumerate(record):
                if item.tag == MAIN+"x":
                    shared = fields[column].find(MAIN+"sharedItems")
                    index = int(item.get("v", "-1"))
                    require(shared is not None and 0 <= index < len(shared), "unsupported_pivot_cache")
                    item = shared[index]
                require(item.tag in (MAIN+"s", MAIN+"n", MAIN+"m"), "unsupported_pivot_cache")
                values.append(float(item.get("v")) if item.tag == MAIN+"n" else item.get("v") if item.tag == MAIN+"s" else "")
            result.append(tuple(values))
        return tuple(result)


def editable(feature, sheet_index, column, row):
    x1, y1, x2, y2 = feature["outputBounds"]
    if sheet_index == feature["outputSheet"] and x1 <= column <= x2 and y1 <= row <= y2:
        return False
    x1, y1, x2, y2 = feature["sourceBounds"]
    if sheet_index == feature["sourceSheet"] and x1 <= column <= x2 and y1 <= row <= y2:
        return row != y1 and column != x1+feature["rowField"]
    return True
