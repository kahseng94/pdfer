import json
from io import BytesIO

import pikepdf
import pytest
from fastapi.testclient import TestClient

from pdfer import bookmarks, core
from pdfer.api import app


def document(password=""):
    with pikepdf.new() as pdf:
        for _ in range(3): pdf.add_blank_page()
        pdf.Root.Names = pikepdf.Dictionary(Dests=pikepdf.Dictionary(Names=pikepdf.Array(['chapter', pikepdf.Array([pdf.pages[1].obj, pikepdf.Name.XYZ, 20, 500, 1.5])])))
        with pdf.open_outline() as outline:
            first = pikepdf.OutlineItem('First', 0)
            first.bold = True
            first.children = [pikepdf.OutlineItem('Named', pikepdf.String('chapter'))]
            outline.root = [first, pikepdf.OutlineItem('Website', action=pikepdf.Dictionary(S=pikepdf.Name.URI, URI='https://example.com'))]
        return core._save(pdf, password)


def test_read_resolves_named_destinations_and_describes_external_actions():
    entries = bookmarks.read(document())['bookmarks']
    assert [(entry['title'], entry['page'], entry['level']) for entry in entries] == [('First', 1, 0), ('Named', 2, 1), ('Website', None, 0)]


def test_rename_reorder_and_add_preserve_zoom_actions_and_style():
    source = document()
    entries = bookmarks.read(source)['bookmarks']
    entries[0]['title'] = 'Renamed'
    result = bookmarks.write(source, json.dumps([entries[2], entries[0], entries[1], dict(id='new', sourceId=None, title='Third', page=3, level=0)]))
    with pikepdf.open(BytesIO(result)) as pdf:
        outline = pdf.open_outline().root
        assert [item.title for item in outline] == ['Website', 'Renamed', 'Third']
        assert outline[0].action.URI == 'https://example.com'
        assert outline[1].bold
        child = outline[1].children[0]
        assert str(child.destination) == 'chapter'
        destination = child.resolved_destination(pdf)
        assert float(destination.zoom) == 1.5
        assert float(destination.top) == 500
        assert pdf.Root.PageMode == pikepdf.Name.UseOutlines


def test_retarget_external_bookmark_and_delete_all_with_password_retained():
    source = document('secret')
    entries = bookmarks.read(source, password='secret')['bookmarks']
    entries[2]['page'] = 3
    result = bookmarks.write(source, json.dumps(entries), password='secret')
    assert bookmarks.read(result, password='secret')['bookmarks'][2]['page'] == 3
    with pytest.raises(pikepdf.PasswordError): pikepdf.open(BytesIO(result))
    assert bookmarks.read(bookmarks.write(source, '[]', password='secret'), password='secret')['bookmarks'] == []


@pytest.mark.parametrize('entry', [dict(id='new', title='', page=1, level=0), dict(id='new', title='A', page=4, level=0), dict(id='new', title='A', page=1, level=1), dict(id='new', title='A', page=None, level=0)])
def test_invalid_bookmarks_rejected(entry):
    with pytest.raises(core.PdfToolError): bookmarks.write(document(), json.dumps([entry]))


def test_api_bookmarks_and_duplicate_source_rejected():
    client = TestClient(app)
    source = document()
    read = client.post('/api/bookmarks/read', files={'file': ('source.pdf', source, 'application/pdf')})
    assert read.status_code == 200
    entries = read.json()['bookmarks']
    result = client.post('/api/bookmarks', files={'file': ('source.pdf', source, 'application/pdf')}, data={'entries': json.dumps(entries)})
    assert result.status_code == 200
    assert 'source_bookmarks.pdf' in result.headers['content-disposition']
    entries.append({**entries[0], 'id': 'copy'})
    with pytest.raises(core.PdfToolError, match='duplicated'): bookmarks.write(source, json.dumps(entries))


def test_maximum_supported_depth_roundtrips_without_rejecting_leaf_children():
    entries = [dict(id=f'new-{level}', sourceId=None, title=f'Level {level + 1}', page=1, level=level) for level in range(17)]
    result = bookmarks.write(document(), json.dumps(entries))
    loaded = bookmarks.read(result)['bookmarks']
    assert len(loaded) == 17 and loaded[-1]['level'] == 16
