from html import unescape
from pathlib import Path
import re

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import BaseDocTemplate, Frame, PageTemplate, Paragraph, PageBreak, Spacer, Table, TableStyle

ROOT = Path(__file__).parent
SOURCE = (ROOT / "admin-operations-guide.html").read_text(encoding="utf-8")
OUTPUT = ROOT / "admin-operations-guide.pdf"

def plain(value):
    value = re.sub(r"<br\s*/?>", " ", value, flags=re.I)
    value = re.sub(r"<[^>]+>", " ", value)
    value = unescape(value)
    return re.sub(r"\s+", " ", value).strip()

def extract(pattern, text, flags=re.S | re.I):
    match = re.search(pattern, text, flags)
    return match.group(1) if match else ""

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name="CoverBrand", parent=styles["Normal"], fontName="Helvetica-Bold", fontSize=10, leading=14, textColor=colors.HexColor("#ff8b94"), spaceAfter=22*mm, tracking=1.2))
styles.add(ParagraphStyle(name="CoverTitle", parent=styles["Title"], fontName="Helvetica-Bold", fontSize=38, leading=40, textColor=colors.white, alignment=TA_LEFT, spaceAfter=10*mm))
styles.add(ParagraphStyle(name="CoverBody", parent=styles["Normal"], fontSize=14, leading=21, textColor=colors.HexColor("#e3e3e7")))
styles.add(ParagraphStyle(name="Kicker", parent=styles["Normal"], fontName="Helvetica-Bold", fontSize=8, leading=11, textColor=colors.HexColor("#d81f2b"), spaceAfter=3*mm, tracking=1))
styles.add(ParagraphStyle(name="ChapterTitle", parent=styles["Heading1"], fontName="Helvetica-Bold", fontSize=22, leading=26, textColor=colors.HexColor("#202127"), spaceAfter=5*mm))
styles.add(ParagraphStyle(name="StepTitle", parent=styles["Heading3"], fontName="Helvetica-Bold", fontSize=11, leading=14, textColor=colors.HexColor("#bd1824"), spaceAfter=1.5*mm))
styles.add(ParagraphStyle(name="BodyCopy", parent=styles["BodyText"], fontName="Helvetica", fontSize=9.4, leading=14.2, textColor=colors.HexColor("#393b43"), spaceAfter=3*mm))
styles.add(ParagraphStyle(name="LeadCopy", parent=styles["BodyText"], fontSize=11, leading=16, textColor=colors.HexColor("#565963"), spaceAfter=5*mm))
styles.add(ParagraphStyle(name="FooterCopy", parent=styles["Normal"], fontSize=8, textColor=colors.HexColor("#737680")))

def para(text, style="BodyCopy"):
    return Paragraph(plain(text).replace("&", "&amp;"), styles[style])

def draw_page(canvas, doc):
    canvas.saveState()
    if doc.page > 1:
        canvas.setStrokeColor(colors.HexColor("#e51c2a"))
        canvas.setLineWidth(1)
        canvas.line(17*mm, 14*mm, 193*mm, 14*mm)
        canvas.setFont("Helvetica", 7.5)
        canvas.setFillColor(colors.HexColor("#777982"))
        canvas.drawString(17*mm, 9*mm, "ESPORT ENGINE  /  ADMIN OPERATIONS GUIDE")
        canvas.drawRightString(193*mm, 9*mm, str(doc.page))
    canvas.restoreState()

doc = BaseDocTemplate(str(OUTPUT), pagesize=A4, leftMargin=17*mm, rightMargin=17*mm, topMargin=17*mm, bottomMargin=20*mm, title="Esport Engine Admin Operations Guide", author="Esport Engine")
frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="normal")
doc.addPageTemplates([PageTemplate(id="guide", frames=frame, onPage=draw_page)])
story = []

cover = extract(r'<section class="cover">(.*?)</section>', SOURCE)
cover_brand = extract(r'<div class="brand">(.*?)</div>', cover)
cover_title = extract(r'<h1>(.*?)</h1>', cover)
cover_copy = extract(r'<p>(.*?)</p>', cover)
cover_stamp = extract(r'<div class="stamp">(.*?)</div>', cover)
cover_table = Table([[Paragraph(plain(cover_brand), styles["CoverBrand"])], [Paragraph(plain(cover_title).replace(" ", "<br/>", 1), styles["CoverTitle"])], [para(cover_copy, "CoverBody")], [Spacer(1, 42*mm)], [Paragraph(plain(cover_stamp), styles["FooterCopy"])]], colWidths=[170*mm], rowHeights=[28*mm, 52*mm, 32*mm, 70*mm, 12*mm])
cover_table.setStyle(TableStyle([("BACKGROUND", (0,0),(-1,-1), colors.HexColor("#202127")), ("BOX", (0,0),(-1,-1), 0, colors.HexColor("#202127")), ("LEFTPADDING",(0,0),(-1,-1),13*mm), ("RIGHTPADDING",(0,0),(-1,-1),13*mm), ("TOPPADDING",(0,0),(-1,-1),7*mm), ("BOTTOMPADDING",(0,0),(-1,-1),0)]))
story.extend([cover_table, PageBreak()])

intro = extract(r'<section class="intro">(.*?)</section>', SOURCE)
story.extend([para(extract(r'<div class="kicker">(.*?)</div>', intro), "Kicker"), para(extract(r'<h2>(.*?)</h2>', intro), "ChapterTitle"), para(extract(r'<p>(.*?)</p>', intro), "LeadCopy")])
note = extract(r'<div class="note">(.*?)</div>', intro)
if note:
    story.append(para("NOTE: " + note))
story.append(Spacer(1, 6*mm))

chapters = re.findall(r'<section class="chapter">(.*?)</section>', SOURCE, re.S | re.I)
for index, chapter in enumerate(chapters):
    story.append(PageBreak())
    story.append(para(extract(r'<div class="kicker">(.*?)</div>', chapter), "Kicker"))
    story.append(para(extract(r'<h2>(.*?)</h2>', chapter), "ChapterTitle"))
    lead = extract(r'<p class="lead">(.*?)</p>', chapter)
    if lead:
        story.append(para(lead, "LeadCopy"))
    steps = re.findall(r'<div class="step">(.*?)</div>', chapter, re.S | re.I)
    for step in steps:
        title = extract(r'<h3>(.*?)</h3>', step)
        body = re.sub(r'<h3>.*?</h3>', '', step, flags=re.S | re.I)
        story.extend([para(title, "StepTitle"), para(body), Spacer(1, 2*mm)])
    if not steps:
        items = re.findall(r'<li>(.*?)</li>', chapter, re.S | re.I)
        for item in items:
            story.append(para("[  ]  " + item))
    callout = extract(r'<div class="note">(.*?)</div>', chapter)
    if callout:
        story.append(Spacer(1, 2*mm))
        story.append(para("NOTE: " + callout))
    small = extract(r'<p class="small">(.*?)</p>', chapter)
    if small:
        story.append(para(small, "FooterCopy"))
    footer = extract(r'<div class="footer">(.*?)</div>', chapter)
    if footer:
        story.append(Spacer(1, 6*mm))
        story.append(para(footer, "FooterCopy"))

doc.build(story)
print(OUTPUT)
print(OUTPUT.stat().st_size)
