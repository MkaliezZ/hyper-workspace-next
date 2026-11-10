"""Synthetic preservation fixtures for real Office save/readback tests.

create FORMAT writes an OOXML file to stdout. verify FORMAT PATH MARKER checks
the downloaded file after a real edit/save; it does not drive an editor.
"""
import io
import json
import sys


def create(kind):
    output = io.BytesIO()
    if kind == "docx":
        from docx import Document
        document = Document()
        document.add_heading("Synthetic collaboration record", level=1)
        paragraph = document.add_paragraph("Preserved paragraph. ")
        paragraph.add_run("Important fact").bold = True
        table = document.add_table(rows=2, cols=2)
        for row, values in zip(table.rows, [("Item", "Quantity"), ("Pens", "3")]):
            for cell, value in zip(row.cells, values):
                cell.text = value
        document.add_paragraph("Editable text")
        document.save(output)
    elif kind == "xlsx":
        from openpyxl import Workbook
        from openpyxl.chart import BarChart, Reference
        from openpyxl.worksheet.datavalidation import DataValidation
        from openpyxl.worksheet.table import Table, TableStyleInfo
        workbook = Workbook()
        data = workbook.active
        data.title = "Inputs"
        for row in [("Item", "Quantity", "Price", "Total"),
                    ("Pens", 3, 10, "=B2*C2"),
                    ("Paper", 2, 5, "=B3*C3")]:
            data.append(row)
        data["F1"] = "Status"
        data["F2"] = "Draft"
        validation = DataValidation(type="list", formula1='"Draft,Approved"')
        data.add_data_validation(validation)
        validation.add(data["F2"])
        table = Table(displayName="SyntheticItems", ref="A1:D3")
        table.tableStyleInfo = TableStyleInfo(name="TableStyleMedium2", showRowStripes=True)
        data.add_table(table)
        data.auto_filter.ref = "A1:D3"
        report = workbook.create_sheet("Report")
        report.append(("Metric", "Value"))
        report.append(("Pens total", "=Inputs!D2"))
        report.append(("Grand total", "=SUM(Inputs!D2:D3)"))
        report["A5"] = "Edit marker"
        report["B5"] = "Editable text"
        chart = BarChart()
        chart.title = "Synthetic quantities"
        chart.add_data(Reference(data, min_col=2, min_row=1, max_row=3), titles_from_data=True)
        chart.set_categories(Reference(data, min_col=1, min_row=2, max_row=3))
        report.add_chart(chart, "D2")
        workbook.save(output)
    elif kind == "pptx":
        from pptx import Presentation
        from pptx.util import Inches
        presentation = Presentation()
        slide = presentation.slides.add_slide(presentation.slide_layouts[6])
        slide.shapes.add_textbox(0, 0, Inches(8), Inches(1)).text = "Synthetic collaboration record"
        slide.shapes.add_textbox(0, Inches(1), Inches(8), Inches(1)).text = "Editable text"
        table = slide.shapes.add_table(2, 2, 0, Inches(2), Inches(5), Inches(2)).table
        for index, values in enumerate((("Item", "Quantity"), ("Pens", "3"))):
            for column, value in enumerate(values):
                table.cell(index, column).text = value
        second = presentation.slides.add_slide(presentation.slide_layouts[6])
        second.shapes.add_textbox(0, 0, Inches(8), Inches(1)).text = "Preserved second slide"
        presentation.save(output)
    else:
        raise ValueError("Unknown synthetic format")
    return output.getvalue()


def verify(kind, path, marker):
    if kind == "docx":
        from docx import Document
        document = Document(path)
        text = "\n".join(paragraph.text for paragraph in document.paragraphs)
        assert marker in text, "The saved edit is absent"
        assert "Synthetic collaboration record" in text
        assert "Preserved paragraph." in text
        assert any(run.bold and "Important fact" in run.text
                   for paragraph in document.paragraphs for run in paragraph.runs)
        assert [[cell.text for cell in row.cells] for row in document.tables[0].rows] == [
            ["Item", "Quantity"], ["Pens", "3"]]
        return {"edit": True, "paragraphs": True, "bold": True, "table": True}
    if kind == "xlsx":
        from openpyxl import load_workbook
        workbook = load_workbook(path)
        values = load_workbook(path, data_only=True)
        assert workbook["Report"]["B5"].value == marker, "The saved edit is absent"
        assert workbook["Inputs"]["D2"].data_type == "f"
        assert workbook["Report"]["B2"].data_type == "f"
        assert values["Inputs"]["D2"].value == 30, "Formula was not recalculated"
        assert values["Inputs"]["D3"].value == 10
        assert values["Report"]["B2"].value == 30, "Cross-sheet formula changed"
        assert values["Report"]["B3"].value == 40
        assert workbook["Inputs"].auto_filter.ref == "A1:D3"
        assert any("F2" in item and item.type == "list"
                   for item in workbook["Inputs"].data_validations.dataValidation)
        assert len(workbook["Report"]._charts) == 1
        return {"edit": True, "formulas": True, "crossSheet": True,
                "filter": True, "validation": True, "chart": True}
    if kind == "pptx":
        from pptx import Presentation
        presentation = Presentation(path)
        assert len(presentation.slides) == 2
        text = "\n".join(shape.text for slide in presentation.slides
                         for shape in slide.shapes if shape.has_text_frame)
        assert marker in text, "The saved edit is absent"
        assert "Synthetic collaboration record" in text
        assert "Preserved second slide" in text
        table = next(shape.table for shape in presentation.slides[0].shapes if shape.has_table)
        assert [[cell.text for cell in row.cells] for row in table.rows] == [
            ["Item", "Quantity"], ["Pens", "3"]]
        return {"edit": True, "slides": True, "table": True}
    raise ValueError("Unknown synthetic format")


if __name__ == "__main__":
    action, kind = sys.argv[1:3]
    if action == "create":
        sys.stdout.buffer.write(create(kind))
    elif action == "verify":
        print(json.dumps(verify(kind, sys.argv[3], sys.argv[4])))
    else:
        raise ValueError("Unknown fixture action")
