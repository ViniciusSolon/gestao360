"""Gera docs/security-audit/relatorio-auditoria-seguranca.pdf

Uso (ambiente isolado, nada global):
    python3 -m venv docs/security-audit/.venv
    docs/security-audit/.venv/bin/pip install reportlab matplotlib
    docs/security-audit/.venv/bin/python docs/security-audit/gerar_relatorio.py
"""
from __future__ import annotations

import os
from collections import Counter
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from reportlab.lib import colors  # noqa: E402
from reportlab.lib.enums import TA_CENTER  # noqa: E402
from reportlab.lib.pagesizes import A4  # noqa: E402
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet  # noqa: E402
from reportlab.lib.units import cm  # noqa: E402
from reportlab.pdfbase import pdfmetrics  # noqa: E402
from reportlab.pdfbase.ttfonts import TTFont  # noqa: E402
from reportlab.platypus import (  # noqa: E402
    Image, KeepTogether, PageBreak, Paragraph, Preformatted, SimpleDocTemplate, Spacer, Table, TableStyle,
)

import sys  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
from achados import CATEGORIAS, DATA, ESCOPO, FORTES, ISSUES, METODO, PROJETO, RECOMENDACOES, ACHADOS, STATUS

HERE = Path(__file__).resolve().parent
OUT = HERE / "relatorio-auditoria-seguranca.pdf"
TMP = HERE / "_render"
TMP.mkdir(exist_ok=True)

SEV_COR = {"crítica": "#B91C1C", "alta": "#EA580C", "média": "#D97706", "baixa": "#2563EB", "informativa": "#64748B"}
SEV_ORDEM = ["crítica", "alta", "média", "baixa", "informativa"]
FORTE = "#059669"
INK, MUTED, BORDER = "#0F172A", "#475569", "#E2E8F0"

# ---------------------------------------------------------------- fontes (com acentos)
def _fontes():
    base = "/usr/share/fonts/truetype/dejavu/"
    try:
        pdfmetrics.registerFont(TTFont("Body", base + "DejaVuSans.ttf"))
        pdfmetrics.registerFont(TTFont("Body-Bold", base + "DejaVuSans-Bold.ttf"))
        pdfmetrics.registerFont(TTFont("Mono", base + "DejaVuSansMono.ttf"))
        pdfmetrics.registerFontFamily("Body", normal="Body", bold="Body-Bold")
        return "Body", "Body-Bold", "Mono"
    except Exception:
        return "Helvetica", "Helvetica-Bold", "Courier"


FONT, FONT_B, MONO = _fontes()
ss = getSampleStyleSheet()
S = {
    "h1": ParagraphStyle("h1", fontName=FONT_B, fontSize=17, leading=22, textColor=INK, spaceAfter=8, spaceBefore=4),
    "h2": ParagraphStyle("h2", fontName=FONT_B, fontSize=12.5, leading=16, textColor=INK, spaceBefore=10, spaceAfter=5),
    "p": ParagraphStyle("p", fontName=FONT, fontSize=9.3, leading=13, textColor=INK, spaceAfter=4),
    "small": ParagraphStyle("small", fontName=FONT, fontSize=8, leading=10.5, textColor=MUTED),
    "cell": ParagraphStyle("cell", fontName=FONT, fontSize=8, leading=10.2, textColor=INK),
    "cellb": ParagraphStyle("cellb", fontName=FONT_B, fontSize=8, leading=10.2, textColor=INK),
    "chip": ParagraphStyle("chip", fontName=FONT_B, fontSize=7.4, leading=9, textColor=colors.white, alignment=TA_CENTER),
    "code": ParagraphStyle("code", fontName=MONO, fontSize=7, leading=8.8, textColor=INK, backColor="#F8FAFC",
                           borderColor=BORDER, borderWidth=0.5, borderPadding=5, spaceBefore=4, spaceAfter=10),
    "cover_t": ParagraphStyle("ct", fontName=FONT_B, fontSize=24, leading=30, textColor=INK, spaceAfter=10),
    "cover_s": ParagraphStyle("cs", fontName=FONT, fontSize=11, leading=15, textColor=MUTED),
}


def esc(t: str) -> str:
    return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def P(t, st="p"):
    return Paragraph(t, S[st])


# ---------------------------------------------------------------- gráficos
def graficos():
    cont = Counter(a["sev"] for a in ACHADOS)
    sevs = [s for s in SEV_ORDEM if cont[s]]
    vals = [cont[s] for s in sevs]
    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 9, "text.color": INK})

    # Rosca: severidade (rótulos diretos + legenda; texto em tinta neutra, não na cor da série)
    fig, ax = plt.subplots(figsize=(3.6, 3.0), dpi=220)
    ax.pie(vals, colors=[SEV_COR[s] for s in sevs], startangle=90, counterclock=False,
           wedgeprops={"width": 0.36, "edgecolor": "white", "linewidth": 2})
    ax.text(0, 0.08, str(sum(vals)), ha="center", va="center", fontsize=20, fontweight="bold", color=INK)
    ax.text(0, -0.2, "achados", ha="center", va="center", fontsize=8.5, color=MUTED)
    ax.legend([f"{s.capitalize()} ({v})" for s, v in zip(sevs, vals)], loc="center left",
              bbox_to_anchor=(1.0, 0.5), frameon=False, fontsize=8.5, handlelength=1, handleheight=1)
    ax.set_aspect("equal")
    fig.savefig(TMP / "rosca.png", bbox_inches="tight", transparent=False, facecolor="white")
    plt.close(fig)

    # Barras empilhadas horizontais: categoria × severidade (+ pontos fortes ao lado)
    cats = [c["nome"] for c in CATEGORIAS]
    fig, ax = plt.subplots(figsize=(6.6, 2.9), dpi=220)
    left = [0] * len(cats)
    for s in SEV_ORDEM:
        row = [sum(1 for a in ACHADOS if a["cat"] == c["id"] and a["sev"] == s) for c in CATEGORIAS]
        if not any(row):
            continue
        ax.barh(cats, row, left=left, color=SEV_COR[s], height=0.5, edgecolor="white", linewidth=2, label=s.capitalize())
        left = [l + r for l, r in zip(left, row)]
    fortes = [sum(1 for f in FORTES if f["cat"] == c["id"]) for c in CATEGORIAS]
    for i, (tot, f) in enumerate(zip(left, fortes)):
        ax.text(tot + 0.12, i, f"{tot} achado(s) · {f} ponto(s) forte(s)", va="center", fontsize=7.8, color=MUTED)
    ax.invert_yaxis()
    ax.set_xlim(0, max(left + [1]) + 4.2)
    ax.xaxis.set_major_locator(matplotlib.ticker.MaxNLocator(integer=True))
    for sp in ("top", "right", "left"):
        ax.spines[sp].set_visible(False)
    ax.spines["bottom"].set_color(BORDER)
    ax.tick_params(axis="y", length=0, labelsize=8.3)
    ax.tick_params(axis="x", colors=MUTED, labelsize=7.5)
    ax.grid(axis="x", color=BORDER, linewidth=0.6)
    ax.set_axisbelow(True)
    ax.legend(frameon=False, fontsize=7.8, ncol=5, loc="lower center", bbox_to_anchor=(0.45, -0.32), handlelength=1)
    fig.savefig(TMP / "barras.png", bbox_inches="tight", facecolor="white")
    plt.close(fig)


# ---------------------------------------------------------------- blocos
def chip(sev: str):
    t = Table([[P(sev.upper(), "chip")]], colWidths=[2.0 * cm], rowHeights=[0.5 * cm])
    t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), SEV_COR.get(sev, FORTE)),
                           ("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LEFTPADDING", (0, 0), (-1, -1), 2),
                           ("RIGHTPADDING", (0, 0), (-1, -1), 2), ("ROUNDEDCORNERS", [4, 4, 4, 4])]))
    return t


def tabela(rows, widths, header):
    data = [[P(h, "cellb") for h in header]] + rows
    t = Table(data, colWidths=widths, repeatRows=1)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), "#F1F5F9"),
        ("LINEBELOW", (0, 0), (-1, -1), 0.4, BORDER),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4),
    ]))
    return t


def cabecalho_rodape(canvas, doc):
    canvas.saveState()
    w, h = A4
    if doc.page > 1:
        canvas.setFont(FONT, 7.5)
        canvas.setFillColor(MUTED)
        canvas.drawString(2 * cm, h - 1.25 * cm, f"Relatório de Auditoria de Segurança — {PROJETO}")
        canvas.drawRightString(w - 2 * cm, h - 1.25 * cm, DATA)
        canvas.setStrokeColor(BORDER)
        canvas.line(2 * cm, h - 1.4 * cm, w - 2 * cm, h - 1.4 * cm)
        canvas.line(2 * cm, 1.4 * cm, w - 2 * cm, 1.4 * cm)
        canvas.drawString(2 * cm, 1.0 * cm, "Confidencial — uso interno")
        canvas.drawRightString(w - 2 * cm, 1.0 * cm, f"Página {doc.page}")
    canvas.restoreState()


def build():
    graficos()
    W = A4[0] - 4 * cm
    st = []
    cont = Counter(a["sev"] for a in ACHADOS)

    # a) capa
    st += [Spacer(1, 3.2 * cm), P(f"Relatório de Auditoria de Segurança — {esc(PROJETO)}", "cover_t"),
           P(f"Data: {DATA}", "cover_s"), Spacer(1, 0.6 * cm), P("<b>Escopo auditado</b>", "h2")]
    st += [P("• " + esc(x)) for x in ESCOPO]
    st += [P("<b>Nota metodológica — como cada categoria foi mapeada para a stack</b>", "h2")]
    st += [tabela([[P(esc(c), "cellb"), P(esc(m), "cell")] for c, m in METODO], [4.2 * cm, W - 4.2 * cm],
                  ["Categoria", "Mapeamento na stack detectada"])]
    st += [Spacer(1, 0.3 * cm), P("Somente achados verificados no código. Itens marcados como reproduzidos foram exercitados contra o servidor de desenvolvimento local; nenhum ambiente de produção foi acessado.", "small"), PageBreak()]

    # b) resumo executivo
    st += [P("Resumo executivo", "h1")]
    resumo = [[P(s.capitalize(), "cellb"), P(str(cont.get(s, 0)), "cell")] for s in SEV_ORDEM]
    resumo.append([P("Pontos fortes verificados", "cellb"), P(str(len(FORTES)), "cell")])
    st += [Table([[tabela(resumo, [4.3 * cm, 1.6 * cm], ["Severidade", "Total"]), Image(str(TMP / "rosca.png"), width=8.6 * cm, height=7.2 * cm)]],
                 colWidths=[6.4 * cm, W - 6.4 * cm], style=[("VALIGN", (0, 0), (-1, -1), "MIDDLE")])]
    st += [P("Achados por categoria (empilhados por severidade)", "h2"), Image(str(TMP / "barras.png"), width=W, height=W * 0.47)]
    st += [P(f"<b>Status em {DATA}:</b> {sum(1 for a in ACHADOS if STATUS.get(a["id"], "").startswith("Corrigido"))} de {len(ACHADOS)} achados corrigidos (incluindo todos os de severidade alta e média); os demais são informativos ou residuais documentados. Suíte de testes: 124 passando.")]
    st += [P("Nenhum achado crítico. Os dois achados altos são de configuração/borda (rate limit contornável por cabeçalho e rota de checkout simulado habilitada pelos defaults do compose) e são corrigíveis em poucas linhas. O isolamento entre empresas está no banco (RLS) e coberto por testes.")]
    st.append(PageBreak())

    # c) pontos fortes e fracos
    st += [P("Pontos fortes (com evidência)", "h1")]
    st += [tabela([[chip("forte") if False else _chip_forte(), P(esc(f["txt"]), "cell"), P(esc(f["ev"]), "cell")] for f in FORTES],
                  [2.1 * cm, 7.6 * cm, W - 9.7 * cm], ["", "O que está protegido", "Evidência"])]
    st += [P("Pontos fracos (riscos centrais)", "h1")]
    fracos = [a for a in ACHADOS if a["sev"] in ("crítica", "alta", "média")]
    st += [tabela([[chip(a["sev"]), P(f"<b>{a['id']}</b> — {esc(a['titulo'])}", "cell"), P(esc(a["impacto"]), "cell"), P(esc(STATUS.get(a["id"], "Pendente")), "cell")] for a in fracos],
                  [2.1 * cm, 5.2 * cm, W - 11.3 * cm, 4.0 * cm], ["Sev.", "Risco", "Impacto", "Status"])]
    st.append(PageBreak())

    # d) achados por categoria
    st += [P("Achados detalhados por categoria", "h1")]
    for c in CATEGORIAS:
        bloco = [P(f"{c['n']}. {esc(c['nome'])}", "h2"), P(esc(c["mecanismo"]), "small"), Spacer(1, 3)]
        itens = [a for a in ACHADOS if a["cat"] == c["id"]]
        if itens:
            rows = []
            for a in itens:
                desc = f"<b>{a['id']} — {esc(a['titulo'])}</b><br/>{esc(a['desc'])}"
                if a.get("trecho"):
                    desc += f"<br/><font name='{MONO}' size='7'>{esc(a['trecho'])}</font>"
                if a.get("condicao"):
                    desc += f"<br/><i>Explorabilidade:</i> {esc(a['condicao'])}"
                if STATUS.get(a["id"]):
                    cor = FORTE if STATUS[a["id"]].startswith("Corrigido") else MUTED
                    desc += f"<br/><font color='{cor}'><b>Status:</b> {esc(STATUS[a['id']])}</font>"
                rows.append([chip(a["sev"]), P(esc(a["loc"]).replace(", ", ",<br/>"), "cell"), P(desc, "cell")])
            bloco.append(tabela(rows, [2.1 * cm, 4.3 * cm, W - 6.4 * cm], ["Severidade", "Arquivo:linha", "Descrição"]))
        else:
            bloco.append(P(c.get("sem_achados", "Nenhum achado verificado nesta categoria.")))
        fs = [f for f in FORTES if f["cat"] == c["id"]]
        if fs:
            bloco.append(P("Verificado e correto: " + "; ".join(esc(f["txt"]) for f in fs) + ".", "small"))
        st += [KeepTogether(bloco[:4]), *bloco[4:]]

    # e) recomendações
    st += [PageBreak(), P("Recomendações priorizadas", "h1")]
    st += [tabela([[P(f"<b>{r[0]}</b>", "cell"), P(esc(r[1]), "cell"), P(esc(r[2]), "cell")] for r in RECOMENDACOES],
                  [1.3 * cm, W - 5.3 * cm, 4.0 * cm], ["Prioridade", "Ação", "Achados"])]

    # f) issues
    st += [PageBreak(), P("ISSUES PARA O GITHUB", "h1"),
           P("Texto completo em Markdown, pronto para copiar e colar. Achados triviais relacionados foram agrupados.", "small")]
    for i, iss in enumerate(ISSUES, 1):
        txt = f"--- ISSUE {i} ---\n{iss.strip()}\n--- FIM ISSUE {i} ---"
        st.append(Preformatted(txt, S["code"], maxLineLength=104, newLineChars=""))

    doc = SimpleDocTemplate(str(OUT), pagesize=A4, leftMargin=2 * cm, rightMargin=2 * cm, topMargin=2 * cm,
                            bottomMargin=2 * cm, title=f"Relatório de Auditoria de Segurança — {PROJETO}", author="Auditoria interna")
    doc.build(st, onFirstPage=cabecalho_rodape, onLaterPages=cabecalho_rodape)
    print(f"gerado: {OUT}")


def _chip_forte():
    t = Table([[P("FORTE", "chip")]], colWidths=[2.0 * cm], rowHeights=[0.5 * cm])
    t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), FORTE), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                           ("ROUNDEDCORNERS", [4, 4, 4, 4])]))
    return t


if __name__ == "__main__":
    os.chdir(HERE)
    build()
