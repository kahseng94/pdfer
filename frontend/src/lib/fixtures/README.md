# PDF comparison fixtures

`compare-original.pdf` and `compare-revised.pdf` contain the same black 40 × 40
point rectangle on a 200 × 150 point page. They use independent AES-256 opening
passwords, `original-secret` and `revised-secret`. They contain no private data.

Generated with the repository's pikepdf dependency:

```python
import pikepdf

for side in ['original', 'revised']:
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(200, 150))
    page.Contents = pdf.make_stream(b'0 0 40 40 re f')
    pdf.save(f'compare-{side}.pdf', encryption=pikepdf.Encryption(
        owner=f'{side}-owner', user=f'{side}-secret', R=6))
```

Other real PDFs are constructed in the integration test to make their text,
image content, geometry and compressed/uncompressed streams easy to inspect.
