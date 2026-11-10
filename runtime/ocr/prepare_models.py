"""Prepare verified model files during the image build."""
import hashlib
from importlib.util import find_spec
from pathlib import Path
import shutil
import sys
from urllib.request import urlopen


MODELS = {
    "PP-OCRv6_det_small.onnx": (
        "090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f",
        "rapidocr", None,
    ),
    "PP-OCRv6_rec_small.onnx": (
        "6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884",
        "rapidocr", None,
    ),
    "ch_ppocr_mobile_v2.0_cls_mobile.onnx": (
        "e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c",
        "rapidocr", None,
    ),
    "layout_cdla.onnx": (
        "25b1f27ec56aa932a48f30cbd6293c358a156280f4b20b0a973bab210c39f62c",
        "rapid_layout",
        "https://www.modelscope.cn/models/RapidAI/RapidLayout/resolve/v1.2.0/onnx/pp_layout/layout_cdla.onnx",
    ),
    "slanet-plus.onnx": (
        "d57a942af6a2f57d6a4a0372573c696a2379bf5857c45e2ac69993f3b334514b",
        None,
        "https://www.modelscope.cn/models/RapidAI/RapidTable/resolve/v2.0.0/slanet-plus.onnx",
    ),
}


def prepare(directory):
    directory.mkdir(parents=True, exist_ok=True)
    for name, (digest, package, url) in MODELS.items():
        target = directory / name
        source = Path(find_spec(package).origin).parent / "models" / name if package else None
        if not target.is_file():
            temporary = target.with_suffix(".part")
            try:
                if source and source.is_file():
                    shutil.copyfile(source, temporary)
                else:
                    if not url:
                        raise FileNotFoundError(f"Model missing from {package}: {name}")
                    with urlopen(url, timeout=60) as response, temporary.open("wb") as output:
                        shutil.copyfileobj(response, output)
                verify(temporary, digest)
                temporary.replace(target)
            finally:
                temporary.unlink(missing_ok=True)
        verify(target, digest)


def verify(path, digest):
    with path.open("rb") as model:
        if hashlib.file_digest(model, "sha256").hexdigest() != digest:
            raise ValueError(f"Unexpected OCR model digest: {path.name}")


if __name__ == "__main__":
    prepare(Path(sys.argv[1]))
