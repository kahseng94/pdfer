import json
import struct
from io import BytesIO
from pathlib import Path

import pytest
from conftest import make_image
from PIL import ExifTags, Image, ImageDraw
from PIL.TiffImagePlugin import IFDRational as R

from pdfer import photos
from pdfer.core import PdfToolError, PhotoCrop

try:
    import pi_heif
except ImportError:  # pragma: no cover - HEIC tests need the decoder
    pi_heif = None

needs_heif = pytest.mark.skipif(pi_heif is None, reason="pi-heif isn't installed")
PHOTOS = Path(__file__).parent / "fixtures/photos"
GPS = ExifTags.IFD.GPSInfo
XMP = (
    b'<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/">'
    b'<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
    b'<rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="5"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>'
)


def quadrants(width: int = 400, height: int = 300, fmt: str = "PNG", mode: str = "RGB", **save) -> bytes:
    """An image whose quadrants are red, green (top), blue and yellow (bottom)."""
    img = Image.new(mode, (width, height))
    draw = ImageDraw.Draw(img)
    w, h = width // 2, height // 2
    draw.rectangle([0, 0, w - 1, h - 1], fill=(255, 0, 0))
    draw.rectangle([w, 0, width - 1, h - 1], fill=(0, 255, 0))
    draw.rectangle([0, h, w - 1, height - 1], fill=(0, 0, 255))
    draw.rectangle([w, h, width - 1, height - 1], fill=(255, 255, 0))
    buf = BytesIO()
    img.save(buf, fmt, **save)
    return buf.getvalue()


def colour(data: bytes, x: int, y: int) -> str:
    r, g, b = Image.open(BytesIO(data)).convert("RGB").getpixel((x, y))
    return {(1, 0, 0): "red", (0, 1, 0): "green", (0, 0, 1): "blue", (1, 1, 0): "yellow", (1, 1, 1): "white", (0, 0, 0): "black"}.get(
        (round(r / 255), round(g / 255), round(b / 255)), f"({r}, {g}, {b})"
    )


def camera_exif(orientation: int = 1, gps: bool = True) -> Image.Exif:
    exif = Image.Exif()
    exif[271] = "Canon"
    exif[272] = "EOS R5"
    exif[274] = orientation
    exif[305] = "pdfer test"
    exif[ExifTags.IFD.Exif] = {
        36867: "2026:11:08 10:00:00", 33434: R(1, 250), 33437: R(28, 10), 34855: 400, 37386: R(50, 1), 41989: R(75, 1), 42036: "RF 50mm",
    }
    if gps:
        exif[GPS] = {1: "N", 2: (R(37, 1), R(46, 1), R(3000, 100)), 3: "W", 4: (R(122, 1), R(25, 1), R(0, 1)), 5: b"\x00", 6: R(1200, 10)}
    return exif


def tagged(fmt: str = "JPEG", orientation: int = 1, gps: bool = True, xmp: bytes | None = XMP, **save) -> bytes:
    """The quadrants with camera EXIF, GPS and XMP, at 300 dpi, in `fmt`."""
    img = Image.open(BytesIO(quadrants()))
    buf = BytesIO()
    extra = {"xmp": xmp} if xmp and fmt != "PNG" else {}
    img.save(buf, fmt, exif=camera_exif(orientation, gps).tobytes(), dpi=(300, 300), **extra, **save)
    return buf.getvalue()


def opened(data: bytes) -> Image.Image:
    image = Image.open(BytesIO(data))
    image.load()
    return image


def exif_of(data: bytes) -> tuple[dict, dict]:
    """(IFD0 as a dict, GPS as a dict) of the image's EXIF."""
    exif = opened(data).getexif()
    return dict(exif), dict(exif.get_ifd(GPS))


def edit(**fields) -> photos.PhotoEdit:
    return photos.parse_photo_edit(json.dumps(fields))


class TestParse:
    def test_empty_edit_changes_nothing(self):
        parsed = edit()
        assert parsed == photos.PhotoEdit()
        assert not parsed.changes_pixels()

    def test_every_field(self):
        parsed = edit(
            rotate=90, flip="vertical", crop={"cx": 10, "cy": 20, "width": 30, "height": 40},
            resize={"width": 100, "height": 50, "fit": "cover", "enlarge": True},
            adjust={"brightness": 1.2, "grayscale": True}, format="webp", quality=70, background="#FF8800", metadata="none",
        )
        assert parsed.rotate == 90 and parsed.flip == "vertical"
        assert parsed.crop == PhotoCrop(10, 20, 30, 40)
        assert parsed.resize == photos.Resize(100, 50, None, None, "cover", True)
        assert parsed.adjust == photos.Adjust(1.2, 1.0, 1.0, 1.0, True)
        assert (parsed.format, parsed.quality, parsed.background, parsed.metadata) == ("webp", 70, (255, 136, 0), "none")
        assert parsed.suffix == "edited" and edit(suffix="").suffix == "" and edit(suffix="no-location").suffix == "no-location"
        assert parsed.changes_pixels()

    def test_identity_adjust_changes_no_pixels(self):
        assert not edit(adjust={"brightness": 1, "contrast": 1.0}).changes_pixels()
        assert edit(adjust={"contrast": 1.5}).changes_pixels()

    @pytest.mark.parametrize(
        ("spec", "message"),
        [
            ("nope", "isn't valid JSON"),
            ("[]", "must be a JSON object"),
            ('{"rotate": 45}', "rotate must be 0, 90, 180 or 270"),
            ('{"rotate": "90"}', "needs a number for rotate"),
            ('{"flip": "diagonal"}', "flip must be one of none, horizontal, vertical"),
            ('{"crop": {"cx": 1}}', "The crop needs a number for cy"),
            ('{"resize": {}}', "needs a width, height, percentage or longest side"),
            ('{"resize": {"percent": 50, "width": 10}}', "can't be combined"),
            ('{"resize": {"width": 20000}}', "width must be between 1 and 10000"),
            ('{"resize": {"width": 10.5}}', "width must be a whole number"),
            ('{"resize": {"width": 10, "fit": "zoom"}}', "fit must be one of contain, cover, stretch"),
            ('{"resize": {"width": 10, "enlarge": "yes"}}', "enlarge must be true or false"),
            ('{"resize": 5}', "The resize must be a JSON object"),
            ('{"adjust": {"brightness": 9}}', "brightness must be between 0 and 4"),
            ('{"format": "gif"}', "format must be one of keep, jpeg, png, webp"),
            ('{"quality": 0}', "quality must be between 1 and 100"),
            ('{"background": "red"}', "background must be a colour like #ffffff"),
            ('{"metadata": "strip"}', "metadata must be one of keep, no-location, none"),
            ('{"suffix": "../x"}', "suffix may only have"),
            ('{"suffix": 5}', "suffix may only have"),
        ],
    )
    def test_errors(self, spec, message):
        with pytest.raises(PdfToolError, match=message):
            photos.parse_photo_edit(spec)


class TestResizePlan:
    @pytest.mark.parametrize(
        ("size", "resize", "plan"),
        [
            ((4000, 3000), {"width": 1200}, ((1200, 900), (1200, 900))),
            ((4000, 3000), {"height": 600}, ((800, 600), (800, 600))),
            ((4000, 3000), {"percent": 50}, ((2000, 1500), (2000, 1500))),
            ((4000, 3000), {"longest": 1600}, ((1600, 1200), (1600, 1200))),
            ((3000, 4000), {"longest": 1600}, ((1200, 1600), (1200, 1600))),
            ((4000, 3000), {"width": 1200, "height": 800}, ((1067, 800), (1067, 800))),
            ((4000, 3000), {"width": 1200, "height": 800, "fit": "cover"}, ((1200, 900), (1200, 800))),
            ((4000, 3000), {"width": 1200, "height": 800, "fit": "stretch"}, ((1200, 800), (1200, 800))),
            ((400, 300), {"width": 1200}, ((400, 300), (400, 300))),
            ((400, 300), {"width": 1200, "height": 800, "fit": "stretch"}, ((400, 300), (400, 300))),
            ((400, 300), {"width": 1200, "height": 800, "fit": "cover"}, ((400, 300), (400, 300))),
            ((400, 300), {"width": 1200, "enlarge": True}, ((1200, 900), (1200, 900))),
            ((400, 300), {"percent": 250, "enlarge": True}, ((1000, 750), (1000, 750))),
            ((3, 3), {"percent": 50}, ((2, 2), (2, 2))),
            ((1, 1), {"percent": 1}, ((1, 1), (1, 1))),
        ],
    )
    def test_plan(self, size, resize, plan):
        assert photos.resize_plan(size, photos.parse_resize(resize)) == plan


class TestEditPhoto:
    def test_nothing_to_do_returns_the_file_as_it_is(self):
        data = quadrants(fmt="JPEG")
        out = photos.edit_photo("IMG_1.jpg", data, edit())
        assert (out.name, out.media_type, out.width, out.height) == ("IMG_1_edited.jpg", "image/jpeg", 400, 300)
        assert out.data == data and out.before == out.after == len(data)

    def test_names(self):
        assert photos.edit_photo("holiday.snap.png", quadrants(), edit(suffix="resized")).name == "holiday.snap_resized.png"
        assert photos.edit_photo("holiday", quadrants(), edit(format="webp", suffix="")).name == "holiday.webp"
        assert photos.edit_photo("", quadrants(), edit(format="jpeg", suffix="")).name == "photo.jpg"

    def test_rotate_clockwise(self):
        out = photos.edit_photo("q.png", quadrants(), edit(rotate=90))
        assert (out.width, out.height) == (300, 400)
        assert [colour(out.data, x, y) for x, y in [(290, 10), (290, 390), (10, 10), (10, 390)]] == ["red", "green", "blue", "yellow"]
        out = photos.edit_photo("q.png", quadrants(), edit(rotate=180))
        assert colour(out.data, 390, 290) == "red"
        out = photos.edit_photo("q.png", quadrants(), edit(rotate=270))
        assert (out.width, out.height, colour(out.data, 10, 390)) == (300, 400, "red")

    def test_flips(self):
        assert colour(photos.edit_photo("q.png", quadrants(), edit(flip="horizontal")).data, 390, 10) == "red"
        assert colour(photos.edit_photo("q.png", quadrants(), edit(flip="vertical")).data, 10, 290) == "red"
        # Turned first, then mirrored: red goes top-right, then back to top-left.
        assert colour(photos.edit_photo("q.png", quadrants(), edit(rotate=90, flip="horizontal")).data, 10, 10) == "red"

    def test_crop_counts_pixels_after_turning(self):
        out = photos.edit_photo("q.png", quadrants(), edit(crop={"cx": 100, "cy": 75, "width": 200, "height": 150}))
        assert (out.width, out.height) == (200, 150)
        assert {colour(out.data, x, y) for x, y in [(0, 0), (199, 149), (100, 75)]} == {"red"}
        # After a quarter turn the picture is 300 wide; its top-left quadrant is blue.
        out = photos.edit_photo("q.png", quadrants(), edit(rotate=90, crop={"cx": 75, "cy": 100, "width": 150, "height": 200}))
        assert (out.width, out.height, colour(out.data, 75, 100)) == (150, 200, "blue")

    def test_crop_half_pixels_round_consistently(self):
        out = photos.edit_photo("q.png", quadrants(), edit(crop={"cx": 100.5, "cy": 75.5, "width": 99, "height": 49}))
        assert (out.width, out.height) == (99, 49)

    def test_crop_is_trimmed_to_the_picture(self):
        out = photos.edit_photo("q.png", quadrants(), edit(crop={"cx": 0, "cy": 0, "width": 100, "height": 100}))
        assert (out.width, out.height, colour(out.data, 10, 10)) == (50, 50, "red")
        with pytest.raises(PdfToolError, match="outside the picture"):
            photos.edit_photo("q.png", quadrants(), edit(crop={"cx": 1000, "cy": 1000, "width": 10, "height": 10}))

    def test_turned_crop_is_resampled(self):
        out = photos.edit_photo("q.png", quadrants(), edit(crop={"cx": 200, "cy": 150, "width": 200, "height": 200, "angle": 90}))
        assert (out.width, out.height) == (200, 200)
        assert [colour(out.data, x, y) for x, y in [(190, 10), (190, 190), (10, 10), (10, 190)]] == ["red", "green", "blue", "yellow"]

    def test_resize_keeps_the_format(self):
        out = photos.edit_photo("q.jpg", quadrants(fmt="JPEG"), edit(resize={"width": 200}, suffix="resized"))
        assert (out.name, out.media_type, out.width, out.height) == ("q_resized.jpg", "image/jpeg", 200, 150)
        assert opened(out.data).format == "JPEG"
        assert colour(out.data, 10, 10) == "red" and colour(out.data, 190, 140) == "yellow"

    def test_resize_cover_cuts_the_middle(self):
        out = photos.edit_photo("q.png", quadrants(), edit(resize={"width": 200, "height": 100, "fit": "cover"}))
        assert (out.width, out.height) == (200, 100)
        assert [colour(out.data, x, y) for x, y in [(10, 10), (190, 10), (10, 90), (190, 90)]] == ["red", "green", "blue", "yellow"]

    def test_resize_never_enlarges_unless_asked(self):
        assert photos.edit_photo("q.png", quadrants(), edit(resize={"width": 4000})).width == 400
        assert photos.edit_photo("q.png", quadrants(), edit(resize={"width": 800, "enlarge": True})).width == 800

    def test_adjust(self):
        black = photos.edit_photo("q.png", quadrants(), edit(adjust={"brightness": 0}))
        assert colour(black.data, 10, 10) == "black"
        grey = photos.edit_photo("q.png", quadrants(), edit(adjust={"saturation": 0}))
        r, g, b = opened(grey.data).convert("RGB").getpixel((10, 10))
        assert r == g == b == 76  # 255 * 299 / 1000, as Pillow greys a pure red
        mono = photos.edit_photo("q.png", quadrants(), edit(adjust={"grayscale": True}))
        assert opened(mono.data).mode == "L" and opened(mono.data).getpixel((10, 10)) == 76
        contrast = photos.edit_photo("q.png", quadrants(), edit(adjust={"contrast": 0}))
        pixels = {opened(contrast.data).convert("RGB").getpixel((x, y)) for x, y in [(10, 10), (390, 290)]}
        assert len(pixels) == 1  # everything becomes the mean grey
        sharp = photos.edit_photo("q.png", quadrants(), edit(adjust={"sharpness": 2}))
        assert colour(sharp.data, 10, 10) == "red"

    def test_grayscale_keeps_transparency(self):
        out = photos.edit_photo("a.png", make_image(20, 20, mode="RGBA"), edit(adjust={"grayscale": True}))
        assert opened(out.data).mode == "LA"

    def test_convert_to_jpeg_lays_transparency_over_the_background(self):
        out = photos.edit_photo("a.png", make_image(20, 20, mode="RGBA"), edit(format="jpeg", background="#0000ff", suffix=""))
        assert (out.name, out.media_type) == ("a.jpg", "image/jpeg")
        r, g, b = opened(out.data).getpixel((10, 10))
        # Half-transparent (200, 30, 60) over blue.
        assert (abs(r - 100) < 6, abs(g - 15) < 6, abs(b - 158) < 6) == (True, True, True)

    def test_convert_to_png_and_webp(self):
        png = photos.edit_photo("q.jpg", quadrants(fmt="JPEG", quality=95), edit(format="png", suffix=""))
        assert (png.name, opened(png.data).format, colour(png.data, 10, 10)) == ("q.png", "PNG", "red")
        webp = photos.edit_photo("a.png", make_image(20, 20, mode="RGBA"), edit(format="webp", quality=80, suffix=""))
        assert (webp.name, opened(webp.data).format, opened(webp.data).mode) == ("a.webp", "WEBP", "RGBA")

    def test_quality_changes_the_size(self):
        noise = Image.merge("RGB", [Image.effect_noise((200, 200), 80) for _ in range(3)])
        buf = BytesIO()
        noise.save(buf, "PNG")
        fine = photos.edit_photo("n.png", buf.getvalue(), edit(format="jpeg", quality=95))
        coarse = photos.edit_photo("n.png", buf.getvalue(), edit(format="jpeg", quality=40))
        assert coarse.after < fine.after

    def test_other_formats_become_jpeg_or_png(self):
        frames = [Image.new("RGB", (10, 10), c) for c in ((255, 0, 0), (0, 255, 0))]
        buf = BytesIO()
        frames[0].save(buf, "GIF", save_all=True, append_images=frames[1:])
        out = photos.edit_photo("anim.gif", buf.getvalue(), edit(resize={"percent": 50}))
        assert (out.name, out.media_type, out.width, colour(out.data, 2, 2)) == ("anim_edited.jpg", "image/jpeg", 5, "red")
        buf = BytesIO()
        Image.new("CMYK", (10, 10)).save(buf, "TIFF")
        assert photos.edit_photo("scan.tif", buf.getvalue(), edit(rotate=90)).media_type == "image/jpeg"
        out = photos.edit_photo("a.bmp", make_image(10, 10, fmt="BMP"), edit(flip="horizontal"))
        assert out.media_type == "image/jpeg"
        out = photos.edit_photo("a.tif", make_image(10, 10, fmt="TIFF", mode="RGBA"), edit(flip="horizontal"))
        assert out.media_type == "image/png" and opened(out.data).convert("RGBA").getpixel((2, 2)) == (200, 30, 60, 128)

    def test_exif_orientation_is_applied_before_everything(self):
        exif = Image.Exif()
        exif[274] = 6
        data = quadrants(fmt="JPEG", exif=exif.tobytes())
        out = photos.edit_photo("q.jpg", data, edit(resize={"percent": 10}))
        # Shown turned 90° clockwise, so 300 × 400 and blue top-left; the tag itself is gone.
        assert (out.width, out.height, colour(out.data, 5, 5)) == (30, 40, "blue")
        assert 274 not in exif_of(out.data)[0]

    def test_unreadable(self):
        with pytest.raises(PdfToolError, match="notes.txt isn't an image pdfer can read."):
            photos.edit_photo("notes.txt", b"hello", edit(rotate=90))

    def test_too_many_pixels(self, monkeypatch):
        monkeypatch.setattr(Image, "MAX_IMAGE_PIXELS", 1000)
        with pytest.raises(PdfToolError, match="q.png has too many pixels"):
            photos.edit_photo("q.png", quadrants(), edit(rotate=90))


@needs_heif
class TestHeic:
    """HEIC photos, as iPhones take them, are decoded by pi-heif; the output is never HEIC.

    pi-heif has no encoder, so the fixtures were written once with pillow-heif 1.8.1:
    `quadrants.heic` and `quadrants_turned.heic` are `quadrants(fmt="HEIF", exif=camera_exif(o).tobytes(), xmp=XMP)`
    with orientation 1 and 6, and `cutout.heic` is `make_image(10, 10, fmt="HEIF", mode="RGBA", quality=-1)`.
    """

    @staticmethod
    def heic(name: str = "quadrants") -> bytes:
        return (PHOTOS / f"{name}.heic").read_bytes()

    def test_is_read_the_right_way_up_and_becomes_a_jpeg(self):
        data = self.heic("quadrants_turned")
        assert data[4:12] == b"ftypheic"
        out = photos.edit_photo("IMG_0001.HEIC", data, edit(resize={"percent": 50}))
        assert (out.name, out.media_type, out.width, out.height) == ("IMG_0001_edited.jpg", "image/jpeg", 150, 200)
        # Shown turned 90° clockwise: blue top-left, green bottom-right.
        assert (colour(out.data, 5, 5), colour(out.data, 140, 190)) == ("blue", "green")
        ifd0, gps = exif_of(out.data)
        assert (ifd0[271], ifd0[272], ifd0.get(274, 1)) == ("Canon", "EOS R5", 1) and gps[1] == "N"

    def test_nothing_to_do_still_makes_a_jpeg(self):
        out = photos.edit_photo("a.heic", self.heic(), edit())
        assert (out.name, out.media_type, out.width, out.height) == ("a_edited.jpg", "image/jpeg", 400, 300)
        assert opened(out.data).format == "JPEG" and colour(out.data, 300, 200) == "yellow"

    def test_transparency_makes_a_png(self):
        out = photos.edit_photo("cutout.heif", self.heic("cutout"), edit(flip="horizontal"))
        assert (out.name, out.media_type) == ("cutout_edited.png", "image/png")
        r, g, b, a = opened(out.data).convert("RGBA").getpixel((2, 2))
        assert (abs(r - 200) <= 2, abs(g - 30) <= 2, abs(b - 60) <= 2, a) == (True, True, True, 128)

    def test_convert_without_location(self):
        out = photos.edit_photo("IMG_1.heic", self.heic(), edit(format="webp", metadata="no-location"))
        assert (out.name, out.media_type, out.width, out.height) == ("IMG_1_edited.webp", "image/webp", 400, 300)
        ifd0, gps = exif_of(out.data)
        assert ifd0[271] == "Canon" and gps == {}

    def test_details(self):
        info = photos.read_photo_info("IMG_1.HEIC", self.heic("quadrants_turned"))
        assert (info["format"], info["media_type"], info["width"], info["height"]) == ("HEIC", "image/heic", 300, 400)
        assert (info["mode"], info["transparency"], info["frames"], info["orientation"]) == ("Colour", False, 1, 1)
        assert info["camera"] == {"make": "Canon", "model": "EOS R5", "lens": "RF 50mm", "software": "pdfer test"}
        assert info["gps"] == {"latitude": 37.775, "longitude": -122.416667, "altitude": 120.0}
        assert info["metadata"]["xmp"] is True
        # The same picture under the general HEIF brand is a HEIF.
        plain = self.heic()
        info = photos.read_photo_info("a.heif", plain[:8] + b"mif1" + plain[12:])
        assert (info["format"], info["media_type"]) == ("HEIF", "image/heif")

    def test_still_rejects_other_files(self):
        with pytest.raises(PdfToolError, match="notes.heic isn't an image pdfer can read."):
            photos.edit_photo("notes.heic", b"\x00\x00\x00\x1cftypheic" + b"\x00" * 40, edit(rotate=90))


class TestMetadataWhenReencoding:
    @pytest.mark.parametrize("fmt", ["jpeg", "png", "webp"])
    def test_kept_without_the_orientation(self, fmt):
        out = photos.edit_photo("q.jpg", tagged(orientation=6), edit(format=fmt, resize={"percent": 50}))
        ifd0, gps = exif_of(out.data)
        assert ifd0[271] == "Canon" and 274 not in ifd0
        assert gps[2] == (37.0, 46.0, 30.0)
        if fmt != "png":
            assert b"xmp:Rating" in opened(out.data).info["xmp"]
        if fmt != "webp":  # WebP has nowhere to record a resolution
            assert tuple(round(v) for v in opened(out.data).info["dpi"]) == (300, 300)

    @pytest.mark.parametrize("fmt", ["jpeg", "png", "webp"])
    def test_no_location(self, fmt):
        out = photos.edit_photo("q.jpg", tagged(), edit(format=fmt, resize={"percent": 50}, metadata="no-location"))
        ifd0, gps = exif_of(out.data)
        assert ifd0[271] == "Canon" and ifd0[272] == "EOS R5" and gps == {}
        assert dict(opened(out.data).getexif().get_ifd(ExifTags.IFD.Exif))[42036] == "RF 50mm"

    def test_no_location_drops_xmp_that_mentions_one(self):
        xmp = XMP.replace(b'xmp:Rating="5"', b'xmp:Rating="5" exif:GPSLatitude="37,46.5N"')
        out = photos.edit_photo("q.jpg", tagged(xmp=xmp), edit(format="jpeg", resize={"percent": 50}, metadata="no-location"))
        assert "xmp" not in opened(out.data).info
        kept = photos.edit_photo("q.jpg", tagged(), edit(format="jpeg", resize={"percent": 50}, metadata="no-location"))
        assert b"xmp:Rating" in opened(kept.data).info["xmp"]

    @pytest.mark.parametrize("fmt", ["jpeg", "png", "webp"])
    def test_none_keeps_only_the_colour_profile(self, fmt):
        img = Image.open(BytesIO(quadrants()))
        buf = BytesIO()
        icc = b"\x00" * 128 + b"fake profile"
        img.save(buf, "JPEG", exif=camera_exif().tobytes(), icc_profile=icc, xmp=XMP)
        out = photos.edit_photo("q.jpg", buf.getvalue(), edit(format=fmt, resize={"percent": 50}, metadata="none"))
        info = opened(out.data).info
        assert "exif" not in info and "xmp" not in info and dict(opened(out.data).getexif()) == {}
        assert info["icc_profile"] == icc

    def test_colour_profile_dropped_when_it_no_longer_fits(self):
        img = Image.open(BytesIO(quadrants()))
        buf = BytesIO()
        img.save(buf, "JPEG", icc_profile=b"\x00" * 128 + b"rgb profile")
        out = photos.edit_photo("q.jpg", buf.getvalue(), edit(adjust={"grayscale": True}))
        assert "icc_profile" not in opened(out.data).info


class TestLosslessMetadata:
    @staticmethod
    def scan(data: bytes) -> bytes:
        return data[data.find(b"\xff\xda") :]

    def test_jpeg_without_location_keeps_the_scan_and_the_camera(self):
        data = tagged()
        out = photos.edit_photo("q.jpg", data, edit(metadata="no-location", suffix="no-location"))
        assert out.name == "q_no-location.jpg" and out.after < out.before
        assert self.scan(out.data) == self.scan(data)
        ifd0, gps = exif_of(out.data)
        assert ifd0[271] == "Canon" and gps == {}
        assert dict(opened(out.data).getexif().get_ifd(ExifTags.IFD.Exif))[36867] == "2026:11:08 10:00:00"
        assert b"xmp:Rating" in opened(out.data).info["xmp"]
        assert opened(out.data).info["dpi"] == (300, 300)

    def test_jpeg_without_location_when_there_was_none_is_unchanged(self):
        data = tagged(gps=False)
        assert photos.edit_photo("q.jpg", data, edit(metadata="no-location")).data == data

    def test_jpeg_without_any_metadata(self):
        data = tagged() + b"trailing secret bytes"
        out = photos.edit_photo("q.jpg", data, edit(metadata="none", suffix="clean"))
        assert dict(opened(out.data).getexif()) == {}
        assert "xmp" not in opened(out.data).info
        assert out.data.endswith(b"\xff\xd9") and b"secret" not in out.data
        assert self.scan(out.data) == self.scan(data)[: len(self.scan(out.data))]
        assert opened(out.data).tobytes() == opened(data).tobytes()

    def test_jpeg_without_metadata_still_knows_which_way_is_up(self):
        data = tagged(orientation=6)
        out = photos.edit_photo("q.jpg", data, edit(metadata="none"))
        ifd0, gps = exif_of(out.data)
        assert ifd0 == {274: 6} and gps == {}
        assert self.scan(out.data) == self.scan(data)

    def test_jpeg_keeps_icc_and_adobe_segments_but_not_comments(self):
        img = Image.open(BytesIO(quadrants()))
        buf = BytesIO()
        icc = b"\x00" * 128 + b"fake profile"
        img.save(buf, "JPEG", icc_profile=icc, comment=b"taken at home", exif=camera_exif().tobytes())
        out = photos.edit_photo("q.jpg", buf.getvalue(), edit(metadata="none"))
        info = opened(out.data).info
        assert info["icc_profile"] == icc and "comment" not in info and "exif" not in info

    def test_jpeg_with_odd_structure_is_left_to_pillow(self):
        assert photos.strip_metadata(b"\xff\xd8\xff\xe1\x00\x02 not really", "jpeg", "none") is None
        assert photos.strip_metadata(b"\xff\xd8\xff\xe1\x00\x01", "jpeg", "none") is None
        assert photos.strip_metadata(b"\xff\xd8\x00", "jpeg", "none") is None
        with pytest.raises(PdfToolError, match="isn't an image"):
            photos.edit_photo("q.jpg", b"\xff\xd8\xff\xe1\x00\x02 not really", edit(metadata="none"))

    def test_png(self):
        img = Image.open(BytesIO(quadrants()))
        buf = BytesIO()
        from PIL.PngImagePlugin import PngInfo

        text = PngInfo()
        text.add_text("Comment", "home")
        text.add_itxt("XML:com.adobe.xmp", XMP.decode())
        img.save(buf, "PNG", exif=camera_exif().tobytes(), pnginfo=text, dpi=(300, 300))
        data = buf.getvalue()
        idat = [chunk for chunk in self.png_chunks(data) if chunk[0] == b"IDAT"]

        partial = photos.edit_photo("q.png", data, edit(metadata="no-location")).data
        ifd0, gps = exif_of(partial)
        assert ifd0[271] == "Canon" and gps == {}
        assert [c for c in self.png_chunks(partial) if c[0] == b"IDAT"] == idat
        assert opened(partial).info["Comment"] == "home"

        clean = photos.edit_photo("q.png", data, edit(metadata="none")).data
        assert dict(opened(clean).getexif()) == {} and "Comment" not in opened(clean).info
        kinds = [c[0] for c in self.png_chunks(clean)]
        assert b"iTXt" not in kinds and b"tEXt" not in kinds and b"pHYs" in kinds
        assert opened(clean).tobytes() == opened(data).tobytes()

    @staticmethod
    def png_chunks(data: bytes) -> list[tuple[bytes, bytes]]:
        chunks, i = [], 8
        while i < len(data):
            (length,) = struct.unpack(">I", data[i : i + 4])
            chunks.append((data[i + 4 : i + 8], data[i + 8 : i + 8 + length]))
            i += 12 + length
        return chunks

    def test_webp(self):
        data = tagged("WEBP", orientation=6)
        pixels = opened(data).tobytes()
        partial = photos.edit_photo("q.webp", data, edit(metadata="no-location")).data
        ifd0, gps = exif_of(partial)
        assert ifd0[271] == "Canon" and gps == {} and opened(partial).tobytes() == pixels
        assert b"xmp:Rating" in opened(partial).info["xmp"]
        clean = photos.edit_photo("q.webp", data, edit(metadata="none")).data
        assert dict(opened(clean).getexif()) == {274: 6} and "xmp" not in opened(clean).info
        assert opened(clean).tobytes() == pixels
        assert struct.unpack("<I", clean[4:8])[0] == len(clean) - 8
        flags = clean[clean.find(b"VP8X") + 8]
        assert flags & 0x08 and not flags & 0x04

    def test_simple_webp_has_nothing_to_strip(self):
        buf = BytesIO()
        Image.new("RGB", (10, 10), (255, 0, 0)).save(buf, "WEBP")
        data = buf.getvalue()
        assert photos.edit_photo("q.webp", data, edit(metadata="none")).data == data

    def test_strip_metadata_rejects_other_formats(self):
        assert photos.strip_metadata(make_image(10, 10, fmt="BMP"), "bmp", "none") is None
        assert photos.strip_metadata(b"not a png", "png", "none") is None
        assert photos.strip_metadata(b"RIFF\x00\x00\x00\x00WAVE", "webp", "none") is None

    def test_gif_metadata_is_stripped_by_recompressing(self):
        out = photos.edit_photo("a.gif", make_image(10, 10, fmt="GIF"), edit(metadata="none"))
        assert out.media_type == "image/jpeg"


class TestInfo:
    def test_camera_photo(self):
        info = photos.read_photo_info("IMG_1.jpg", tagged(orientation=6))
        assert (info["format"], info["media_type"], info["width"], info["height"]) == ("JPEG", "image/jpeg", 300, 400)
        assert (info["mode"], info["transparency"], info["frames"], info["dpi"], info["orientation"]) == ("Colour", False, 1, [300, 300], 6)
        assert info["camera"] == {"make": "Canon", "model": "EOS R5", "lens": "RF 50mm", "software": "pdfer test"}
        assert info["taken"] == "2026-11-08 10:00:00"
        assert info["exposure"] == {"time": "1/250 s", "aperture": "f/2.8", "iso": 400, "focal_length": "50 mm", "focal_length_35mm": "75 mm"}
        assert info["gps"] == {"latitude": 37.775, "longitude": -122.416667, "altitude": 120.0}
        assert info["author"] == {"artist": None, "copyright": None, "description": None}
        assert info["metadata"] == {"exif_tags": 4 + 2 + 7 + 6, "xmp": True, "icc_profile": False, "iptc": False}
        assert info["bytes"] == len(tagged(orientation=6)) and info["name"] == "IMG_1.jpg"

    def test_plain_png(self):
        info = photos.read_photo_info("a.png", make_image(20, 10, mode="RGBA"))
        assert (info["width"], info["height"], info["mode"], info["transparency"]) == (20, 10, "Colour with transparency", True)
        assert info["camera"] == {"make": None, "model": None, "lens": None, "software": None}
        assert info["taken"] is None and info["gps"] is None and info["orientation"] is None and info["dpi"] is None
        assert info["metadata"] == {"exif_tags": 0, "xmp": False, "icc_profile": False, "iptc": False}

    def test_odd_values_are_left_out(self):
        exif = Image.Exif()
        exif[274] = 9
        exif[ExifTags.IFD.Exif] = {36867: "0000:00:00 00:00:00", 33434: R(0, 1), 34855: 0}
        exif[GPS] = {1: "N", 2: (R(999, 1), R(0, 1), R(0, 1)), 5: b"\x01", 6: R(50, 1)}
        info = photos.read_photo_info("q.jpg", quadrants(fmt="JPEG", exif=exif.tobytes()))
        assert info["orientation"] is None and info["taken"] is None
        assert info["exposure"]["time"] is None and info["exposure"]["iso"] is None
        assert info["gps"] is None

    def test_animated_and_palette(self):
        frames = [Image.new("RGB", (10, 10), c).quantize(4) for c in ((255, 0, 0), (0, 255, 0), (0, 0, 255))]
        buf = BytesIO()
        frames[0].save(buf, "GIF", save_all=True, append_images=frames[1:])
        info = photos.read_photo_info("a.gif", buf.getvalue())
        assert (info["frames"], info["mode"], info["format"]) == (3, "Palette", "GIF")

    def test_unreadable(self):
        with pytest.raises(PdfToolError, match="notes.txt isn't an image pdfer can read."):
            photos.read_photo_info("notes.txt", b"hello")
