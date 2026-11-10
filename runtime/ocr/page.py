"""Decode one OCR page into a bounded image without storing the source."""
from io import BytesIO
import subprocess

from PIL import Image, ImageOps, UnidentifiedImageError


MAX_BYTES = 8 * 1024 * 1024
MAX_SIDE = 2048
MAX_PIXELS = 24_000_000
IMAGE_FORMATS = {"image/png": "PNG", "image/jpeg": "JPEG"}


class InvalidPage(ValueError):
    pass


def open_page(content: bytes, mime: str, page: int) -> Image.Image:
    if not 1 <= len(content) <= MAX_BYTES or not 1 <= page <= 50:
        raise InvalidPage("Invalid input size or page")
    if mime == "application/pdf":
        if not content.startswith(b"%PDF-"):
            raise InvalidPage("Invalid PDF signature")
        try:
            rendered = subprocess.run(
                ["pdftoppm", "-f", str(page), "-l", str(page), "-singlefile",
                 "-scale-to", str(MAX_SIDE), "-png", "-"],
                input=content, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                timeout=12, check=True,
            )
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            raise InvalidPage("PDF page could not be rendered") from None
        return open_image(rendered.stdout, "PNG")
    if page != 1 or mime not in IMAGE_FORMATS:
        raise InvalidPage("Unsupported input type or page")
    return open_image(content, IMAGE_FORMATS[mime])


def open_image(content: bytes, expected_format: str) -> Image.Image:
    try:
        with Image.open(BytesIO(content), formats=[expected_format]) as source:
            if source.width * source.height > MAX_PIXELS:
                raise InvalidPage("Image exceeds pixel limit")
            oriented = ImageOps.exif_transpose(source)
            oriented.thumbnail((MAX_SIDE, MAX_SIDE))
            if oriented.mode in {"P", "PA", "LA", "RGBA"}:
                foreground = oriented.convert("RGBA")
                background = Image.new("RGBA", foreground.size, "white")
                return Image.alpha_composite(background, foreground).convert("RGB")
            return oriented.convert("RGB")
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError, SyntaxError):
        raise InvalidPage("Image could not be decoded") from None
