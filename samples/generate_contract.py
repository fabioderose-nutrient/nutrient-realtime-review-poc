"""Generates the fictitious contract that the review demo opens.

    documents/master-services-agreement.pdf   a 4-page master services agreement

Every company, person, address, figure and date in it is invented.

    pip install -r samples/requirements.txt
    python samples/generate_contract.py
"""

from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import KeepTogether, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

ROOT = Path(__file__).resolve().parent.parent
PDF = ROOT / "documents" / "master-services-agreement.pdf"

CUSTOMER = "Larkspur Data Systems Ltd"
SUPPLIER = "Ashcombe Cloud Services Ltd"

BODY = ParagraphStyle("body", fontName="Helvetica", fontSize=10.5, leading=15, alignment=TA_JUSTIFY, spaceAfter=6)
CLAUSE = ParagraphStyle("clause", parent=BODY, leftIndent=11 * mm, firstLineIndent=-11 * mm)
HEAD = ParagraphStyle("head", parent=BODY, fontName="Helvetica-Bold", fontSize=11.5, spaceBefore=10, spaceAfter=6,
                      alignment=0)
TITLE = ParagraphStyle("title", parent=BODY, fontName="Helvetica-Bold", fontSize=20, leading=26, alignment=TA_CENTER)
CENTER = ParagraphStyle("center", parent=BODY, alignment=TA_CENTER)
CELL = ParagraphStyle("cell", parent=BODY, fontSize=9.5, leading=12, alignment=0, spaceAfter=0)
CELL_BOLD = ParagraphStyle("cellbold", parent=CELL, fontName="Helvetica-Bold")

SECTIONS = [
    ("1. Definitions", [
        ("1.1", "<b>Agreement</b> means these terms, the schedules and every Statement of Work signed under them."),
        ("1.2", "<b>Services</b> means the managed hosting, monitoring and support services described in "
                "Schedule 1 and in each Statement of Work."),
        ("1.3", "<b>Service Credits</b> means the reductions of the Monthly Fee set out in Schedule 2 when the "
                "Supplier misses a Service Level."),
        ("1.4", "<b>Customer Data</b> means all data, including personal data, that the Customer or its users "
                "upload to or create in the Services."),
        ("1.5", "<b>Business Day</b> means a day other than a Saturday, Sunday or public holiday in the place "
                "where the Customer has its registered office."),
    ]),
    ("2. Services", [
        ("2.1", "The Supplier shall provide the Services from the Commencement Date with the skill, care and "
                "diligence of a competent provider of similar services."),
        ("2.2", "The Supplier shall meet the Service Levels in Schedule 2. Availability is measured monthly and "
                "excludes planned maintenance announced at least five Business Days in advance."),
        ("2.3", "The Customer may request changes to the Services in writing. No change is binding until both "
                "parties sign a change note that states its effect on the fees and the timetable."),
    ]),
    ("3. Fees and payment", [
        ("3.1", "The Customer shall pay the fees set out in the fee schedule below. All fees are exclusive of "
                "VAT, which the Customer shall pay at the applicable rate."),
        ("3.2", "The Supplier shall invoice the Monthly Fee in advance on the first Business Day of each month. "
                "The Customer shall pay each undisputed invoice within 45 days of receipt."),
        ("3.3", "Late payments bear interest at 4% per year above the base rate of the central bank, accruing "
                "daily from the due date until payment."),
        ("3.4", "From the first anniversary of the Commencement Date, the Supplier may increase the fees once "
                "per year by giving 60 days' written notice. Each increase shall not exceed 6%."),
    ]),
]

SECTIONS_2 = [
    ("4. Term and termination", [
        ("4.1", "This Agreement starts on the Commencement Date and continues for an initial term of 36 months. "
                "It then renews for successive periods of 12 months unless either party gives at least 90 "
                "days' notice before the end of the current term."),
        ("4.2", "Either party may terminate this Agreement with immediate effect by written notice if the other "
                "party commits a material breach that is not remedied within 30 days of a notice requiring it."),
        ("4.3", "On termination, the Supplier shall return all Customer Data in a commonly used format within "
                "30 days and then securely delete every copy, unless the law requires it to keep one."),
    ]),
    ("5. Liability", [
        ("5.1", "Nothing in this Agreement limits liability for death or personal injury caused by negligence, "
                "for fraud, or for any other liability that cannot be limited by law."),
        ("5.2", "Subject to clause 5.1, each party's total liability arising under or in connection with this "
                "Agreement in any contract year shall not exceed 150% of the fees paid or payable in that year."),
        ("5.3", "Neither party is liable for loss of profits, loss of business, or any indirect or "
                "consequential loss."),
    ]),
    ("6. Confidentiality", [
        ("6.1", "Each party shall keep the other party's confidential information secret and use it only to "
                "perform this Agreement. This obligation survives termination for five years."),
        ("6.2", "A party may disclose confidential information to its employees, advisers and subcontractors who "
                "need to know it, provided that they are bound by equivalent obligations."),
    ]),
    ("7. Data protection", [
        ("7.1", "The Supplier processes Customer Data only on the documented instructions of the Customer and "
                "as set out in the data processing schedule."),
        ("7.2", "The Supplier shall notify the Customer without undue delay, and in any case within 48 hours, "
                "after becoming aware of a personal data breach affecting Customer Data."),
        ("7.3", "The Supplier shall not transfer Customer Data outside the agreed hosting regions without the "
                "Customer's prior written consent."),
    ]),
    ("8. General", [
        ("8.1", "Neither party may assign this Agreement without the other party's prior written consent, which "
                "shall not be unreasonably withheld."),
        ("8.2", "This Agreement is governed by the laws of England and Wales. The courts of England and Wales "
                "have exclusive jurisdiction over any dispute arising from it."),
    ]),
]

FEES = [
    ["Item", "Charge", "Billing"],
    ["Onboarding and migration", "18,500.00", "One-off, on signature"],
    ["Managed hosting, production", "7,200.00", "Monthly"],
    ["Managed hosting, test", "1,350.00", "Monthly"],
    ["24/7 monitoring and support", "2,950.00", "Monthly"],
    ["Additional engineering", "860.00", "Per day, on request"],
]

SERVICE_LEVELS = [
    ["Service Level", "Target", "Service Credit"],
    ["Availability, production", "99.9% per month", "5% of the Monthly Fee per 0.1% below target, up to 25%"],
    ["Priority 1 incident response", "30 minutes", "2% of the Monthly Fee per breach"],
    ["Priority 2 incident response", "4 hours", "1% of the Monthly Fee per breach"],
    ["Backup restore test", "Quarterly", "None, reported in the service review"],
]


def table(rows, widths):
    data = [[Paragraph(str(c), CELL_BOLD if i == 0 else CELL) for c in row] for i, row in enumerate(rows)]
    t = Table(data, colWidths=widths)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e8eaee")),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#9aa0aa")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return t


def section(story, title, clauses):
    story.append(Paragraph(title, HEAD))
    for number, text in clauses:
        story.append(Paragraph(f"{number}&nbsp;&nbsp;&nbsp;{text}", CLAUSE))


def footer(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(colors.HexColor("#555b66"))
    canvas.drawString(20 * mm, 12 * mm, "Master Services Agreement - draft for review - version 0.4")
    canvas.drawRightString(A4[0] - 20 * mm, 12 * mm, f"Page {doc.page}")
    canvas.restoreState()


def build():
    PDF.parent.mkdir(parents=True, exist_ok=True)
    doc = SimpleDocTemplate(str(PDF), pagesize=A4, leftMargin=22 * mm, rightMargin=22 * mm, topMargin=22 * mm,
                            bottomMargin=22 * mm, title="Master Services Agreement (draft)",
                            author="Contract review demo", subject="Fictitious sample contract")
    story = [
        Spacer(1, 18 * mm),
        Paragraph("MASTER SERVICES AGREEMENT", TITLE),
        Spacer(1, 4 * mm),
        Paragraph("Draft for internal review", CENTER),
        Spacer(1, 12 * mm),
        Paragraph("<b>This Agreement</b> is made on 3 March 2026 between:", BODY),
        Paragraph(f"(1)&nbsp;&nbsp;<b>{CUSTOMER}</b>, a company registered under number 08814527, whose registered "
                  "office is at 14 Wexcombe Road, Ashford Vale AV3 7QP (the <b>Customer</b>); and", CLAUSE),
        Paragraph(f"(2)&nbsp;&nbsp;<b>{SUPPLIER}</b>, a company registered under number 11290366, whose registered "
                  "office is at Unit 9, Pellam Business Park, Hartwell HW2 4RD (the <b>Supplier</b>).", CLAUSE),
        Spacer(1, 4 * mm),
        Paragraph("<b>Background.</b> The Customer wishes to move its order management platform to a managed "
                  "hosting service. The Supplier has agreed to provide that service on the terms of this "
                  "Agreement.", BODY),
    ]
    for title, clauses in SECTIONS:
        section(story, title, clauses)
    story.append(Spacer(1, 3 * mm))
    story.append(KeepTogether([
        Paragraph("<b>Fee schedule</b> (GBP, excluding VAT)", BODY),
        table(FEES, [70 * mm, 30 * mm, 66 * mm]),
    ]))
    story.append(PageBreak())
    for title, clauses in SECTIONS_2:
        section(story, title, clauses)
    story.append(PageBreak())
    story.append(Paragraph("Schedule 2 - Service Levels and Service Credits", HEAD))
    story.append(table(SERVICE_LEVELS, [52 * mm, 34 * mm, 80 * mm]))
    story.append(Spacer(1, 4 * mm))
    story.append(Paragraph("Service Credits are the Customer's sole financial remedy for a missed Service Level, "
                           "without prejudice to its right to terminate under clause 4.2. Total Service Credits "
                           "in a month shall not exceed 25% of the Monthly Fee.", BODY))
    story.append(Spacer(1, 14 * mm))
    story.append(Paragraph("Signed for and on behalf of the parties", HEAD))
    sign = [
        [Paragraph(f"<b>{CUSTOMER}</b>", CELL), Paragraph(f"<b>{SUPPLIER}</b>", CELL)],
        [Paragraph("Name: Elena Marsh<br/>Title: Head of Procurement<br/><br/>Signature: ____________________"
                   "<br/><br/>Date: ____________", CELL),
         Paragraph("Name: Graham Feld<br/>Title: Managing Director<br/><br/>Signature: ____________________"
                   "<br/><br/>Date: ____________", CELL)],
    ]
    t = Table(sign, colWidths=[83 * mm, 83 * mm])
    t.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("TOPPADDING", (0, 0), (-1, -1), 6)]))
    story.append(t)
    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    print(f"Wrote {PDF.relative_to(ROOT)}")


if __name__ == "__main__":
    build()
