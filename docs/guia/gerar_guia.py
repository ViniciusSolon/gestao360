"""Gera docs/guia/guia-rapido.pdf a partir das capturas em docs/guia/img/.

Capturas: node docs/guia/capturar_telas.cjs docs/guia/img   (sistema rodando em localhost:5173)
PDF:      docs/security-audit/.venv/bin/python docs/guia/gerar_guia.py
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image as PILImage, ImageChops
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import cm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    Image, KeepTogether, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle,
)

HERE = Path(__file__).resolve().parent
IMG = HERE / "img"
TMP = HERE / "_render"
TMP.mkdir(exist_ok=True)
OUT = HERE / "guia-rapido.pdf"

INK, MUTED, BORDER, PRIMARY, SOFT = "#0F172A", "#475569", "#E2E8F0", "#1D4ED8", "#EFF6FF"
W_PAGE, H_PAGE = A4
CONTENT_W = W_PAGE - 4 * cm
MAX_IMG_H = 15.5 * cm

try:
    base = "/usr/share/fonts/truetype/dejavu/"
    pdfmetrics.registerFont(TTFont("Body", base + "DejaVuSans.ttf"))
    pdfmetrics.registerFont(TTFont("Body-Bold", base + "DejaVuSans-Bold.ttf"))
    pdfmetrics.registerFontFamily("Body", normal="Body", bold="Body-Bold")
    FONT, BOLD = "Body", "Body-Bold"
except Exception:
    FONT, BOLD = "Helvetica", "Helvetica-Bold"

S = {
    "title": ParagraphStyle("t", fontName=BOLD, fontSize=28, leading=34, textColor=INK, spaceAfter=10),
    "sub": ParagraphStyle("s", fontName=FONT, fontSize=12.5, leading=18, textColor=MUTED),
    "h1": ParagraphStyle("h1", fontName=BOLD, fontSize=17, leading=22, textColor=INK, spaceBefore=2, spaceAfter=6),
    "h2": ParagraphStyle("h2", fontName=BOLD, fontSize=12, leading=16, textColor=INK, spaceBefore=8, spaceAfter=4),
    "p": ParagraphStyle("p", fontName=FONT, fontSize=10, leading=14.5, textColor=INK, spaceAfter=4),
    "step": ParagraphStyle("step", fontName=FONT, fontSize=10, leading=14.5, textColor=INK, leftIndent=14, bulletIndent=0, spaceAfter=2),
    "cap": ParagraphStyle("cap", fontName=FONT, fontSize=8, leading=10, textColor=MUTED, alignment=TA_CENTER, spaceBefore=3, spaceAfter=8),
    "tip": ParagraphStyle("tip", fontName=FONT, fontSize=9.3, leading=13.5, textColor=INK),
    "cell": ParagraphStyle("cell", fontName=FONT, fontSize=9, leading=12, textColor=INK),
    "cellb": ParagraphStyle("cellb", fontName=BOLD, fontSize=9, leading=12, textColor=INK),
}


def P(t, st="p"):
    return Paragraph(t, S[st])


def steps(*items):
    return [Paragraph(t, S["step"], bulletText=f"{i}.") for i, t in enumerate(items, 1)]


def tip(text):
    t = Table([[P(f"<b>Dica:</b> {text}", "tip")]], colWidths=[CONTENT_W])
    t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), SOFT), ("LINEBEFORE", (0, 0), (0, -1), 3, PRIMARY),
                           ("LEFTPADDING", (0, 0), (-1, -1), 10), ("TOPPADDING", (0, 0), (-1, -1), 7),
                           ("BOTTOMPADDING", (0, 0), (-1, -1), 7)]))
    return t


def autocrop(src: Path, pad=40) -> Path:
    """Recorta o fundo liso ao redor do conteúdo (telas de login têm muito espaço vazio)."""
    im = PILImage.open(src).convert("RGB")
    bg = PILImage.new("RGB", im.size, im.getpixel((5, im.height - 5)))
    box = ImageChops.difference(im, bg).getbbox()
    if box:
        l, t, r, b = box
        im = im.crop((max(0, l - pad), max(0, t - pad), min(im.width, r + pad), min(im.height, b + pad)))
    out = TMP / f"crop-{src.name}"
    im.save(out)
    return out


def crop_top(src: Path, max_ratio: float) -> Path:
    """Mantém só o topo de capturas muito altas (altura/largura <= max_ratio)."""
    im = PILImage.open(src)
    h = int(im.width * max_ratio)
    if im.height <= h:
        return src
    out = TMP / f"top-{src.name}"
    im.crop((0, 0, im.width, h)).save(out)
    return out


def shot(name, caption, width=CONTENT_W, crop=None, ratio=None, cell=False):
    path = IMG / name
    if crop == "auto":
        path = autocrop(path)
    if ratio:
        path = crop_top(path, ratio)
    iw, ih = PILImage.open(path).size
    w = width
    h = w * ih / iw
    if h > MAX_IMG_H:
        h = MAX_IMG_H
        w = h * iw / ih
    img = Image(str(path), width=w, height=h)
    frame = Table([[img]], colWidths=[w + 2])
    frame.setStyle(TableStyle([("BOX", (0, 0), (-1, -1), 0.6, BORDER), ("LEFTPADDING", (0, 0), (-1, -1), 1),
                               ("RIGHTPADDING", (0, 0), (-1, -1), 1), ("TOPPADDING", (0, 0), (-1, -1), 1),
                               ("BOTTOMPADDING", (0, 0), (-1, -1), 1)]))
    parts = [frame, P(caption, "cap")]
    return parts if cell else KeepTogether(parts)  # KeepTogether não funciona dentro de célula de tabela


def table(rows, widths, header):
    t = Table([[P(h, "cellb") for h in header]] + [[P(c, "cell") for c in r] for r in rows], colWidths=widths)
    t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), "#F1F5F9"), ("LINEBELOW", (0, 0), (-1, -1), 0.4, BORDER),
                           ("VALIGN", (0, 0), (-1, -1), "TOP"), ("TOPPADDING", (0, 0), (-1, -1), 5),
                           ("BOTTOMPADDING", (0, 0), (-1, -1), 5)]))
    return t


def header_footer(canvas, doc):
    canvas.saveState()
    if doc.page > 1:
        canvas.setFont(FONT, 7.5)
        canvas.setFillColor(MUTED)
        canvas.drawString(2 * cm, H_PAGE - 1.25 * cm, "Gestão 360° — Guia rápido")
        canvas.drawRightString(W_PAGE - 2 * cm, 1.0 * cm, f"Página {doc.page}")
        canvas.setStrokeColor(BORDER)
        canvas.line(2 * cm, H_PAGE - 1.4 * cm, W_PAGE - 2 * cm, H_PAGE - 1.4 * cm)
    canvas.restoreState()


def build():
    st = []
    # Capa
    st += [Spacer(1, 2.2 * cm), P("Gestão 360°", "title"), P("Guia rápido de uso — CRM: leads, funil, agenda, propostas e indicadores", "sub"),
           Spacer(1, 0.8 * cm), shot("03-funil.png", "O funil comercial em Kanban"), Spacer(1, 0.4 * cm),
           P("<b>Neste guia</b>"),
           *steps("Criar a conta e entender os papéis", "Indicadores", "Funil e leads", "Agenda de atividades",
                  "Produtos", "Propostas e PDF", "Equipe", "Assinatura", "Painel da plataforma (equipe interna)"),
           PageBreak()]

    # 1
    st += [P("1. Criar a conta da empresa", "h1"),
           P("Acesse <b>/cadastro</b>, informe o nome da empresa, um identificador (só letras minúsculas, números e hífen), seu nome, e-mail e uma senha de pelo menos 10 caracteres. A conta começa com <b>14 dias de teste grátis</b> no plano Starter, e quem cria vira o <b>Proprietário</b>."),
           shot("01-cadastro.png", "Tela de cadastro", width=9 * cm, crop="auto"),
           P("Quem pode fazer o quê", "h2"),
           table([
               ["Proprietário", "Tudo, inclusive assinar/trocar o plano"],
               ["Administrador", "Convidar e gerenciar a equipe, criar etapas do funil, além do que o gerente faz"],
               ["Gerente", "Ver os leads de todos, cadastrar produtos, apagar leads, dar até 20% de desconto"],
               ["Vendedor", "Ver e trabalhar só os próprios leads e os sem responsável; desconto de até 10%"],
           ], [3.5 * cm, CONTENT_W - 3.5 * cm], ["Papel", "Permissões"]),
           Spacer(1, 6), tip("As permissões são garantidas pelo servidor e pelo banco de dados — esconder um botão não é a proteção, é só conforto."),
           PageBreak()]

    # 2
    st += [P("2. Indicadores", "h1"),
           P("É a tela inicial. Mostra os números do período escolhido no canto superior direito (padrão: últimos 30 dias). Cada cartão traz a <b>origem</b> do número, para você conferir como foi calculado. Vendedores veem só os próprios números; gerentes e acima veem a empresa toda."),
           shot("02-indicadores.png", "Indicadores: KPIs, funil atual, receita por vendedor e por canal", ratio=0.62),
           table([
               ["Leads captados / MQLs", "Leads criados no período / com pontuação ≥ 50"],
               ["Valor vendido e ticket médio", "Soma e média dos negócios ganhos no período"],
               ["Conversão", "Ganhos ÷ (ganhos + perdidos) no período"],
               ["Previsão (pipeline)", "Valor dos leads abertos × probabilidade de cada etapa"],
               ["Alertas", "Oportunidades paradas há 14+ dias e atividades atrasadas"],
           ], [5 * cm, CONTENT_W - 5 * cm], ["Indicador", "Como é calculado"]),
           PageBreak()]

    # 3
    st += [P("3. Funil comercial (Kanban)", "h1"),
           P("Cada coluna é uma etapa, com a quantidade de leads e o valor somado. <b>Arraste o cartão</b> de uma coluna para outra para mudar a etapa. Ao soltar em <b>Ganho</b>, o negócio entra no valor vendido; em <b>Perdido</b>, o sistema pede o motivo."),
           shot("03-funil.png", "Funil: cada cartão mostra empresa, valor, pontuação, selo MQL e responsável", width=14 * cm, ratio=0.36),
           P("Cadastrar um lead", "h2"),
           *steps("Clique em <b>+ Novo lead</b>.", "Preencha nome (obrigatório), empresa, contato, canal de origem e valor estimado.",
                  "Clique em <b>Salvar</b>. O lead entra na primeira etapa e recebe uma <b>pontuação</b> automática (0–100)."),
           shot("04-novo-lead.png", "Formulário de novo lead", width=11 * cm, ratio=0.62),
           tip("A pontuação considera contato completo, empresa, valor e canal (indicação pontua mais). Leads com 50+ viram <b>MQL</b>. Administradores podem criar etapas novas em <b>+ Etapa</b>."),
           PageBreak()]

    # 4
    st += [P("4. Detalhe do lead", "h1"),
           P("Clique no nome do lead para ver os dados, registrar atividades, criar propostas e acompanhar o <b>histórico</b> completo: quem mudou de etapa, quando, atividades criadas e concluídas, propostas enviadas e aceitas."),
           shot("05-lead.png", "Detalhe do lead com atividades, propostas e histórico", width=12.5 * cm, ratio=1.05),
           P("5. Agenda", "h1"),
           P("Lista ligações, reuniões, tarefas e e-mails. Atividades atrasadas aparecem em vermelho. Reuniões podem ter link de videochamada (Google Meet, Teams, Zoom — só links https). Clique em <b>Concluir</b> quando terminar; use <b>Só minhas</b> para filtrar."),
           shot("06-agenda.png", "Agenda com atividades abertas", width=14 * cm, ratio=0.45),
           PageBreak()]

    # 6
    st += [P("6. Produtos", "h1"),
           P("Gerentes e acima cadastram o catálogo: SKU, nome, preço, NCM (8 dígitos), alíquota estimada de tributos e foto (link https). Produto <b>inativo</b> não pode entrar em propostas novas; clique no status para ativar/desativar."),
           shot("07-produtos.png", "Catálogo de produtos", ratio=0.5),
           tip("Os tributos são uma <b>estimativa</b> comercial a partir do cadastro do produto — não substituem a emissão fiscal."),
           P("7. Propostas", "h1"),
           *steps("No lead, clique em <b>Nova proposta</b> (ou em Propostas → Nova proposta).",
                  "Escolha os produtos, quantidades e desconto de cada item. Informe frete, condições de pagamento e validade.",
                  "Clique em <b>Gerar proposta</b>. A numeração é sequencial e automática."),
           shot("08-nova-proposta.png", "Nova proposta: a prévia é só visual; o total oficial é calculado pelo servidor", ratio=0.5),
           P("Acompanhar e fechar", "h2"),
           P("Na proposta, use <b>Marcar como enviada</b> e depois <b>Aceita</b> ou <b>Recusada</b>. Ao aceitar, o lead vai automaticamente para <b>Ganho</b> com o valor da proposta. O botão <b>PDF</b> gera o documento para enviar ao cliente."),
           shot("10-proposta.png", "Proposta enviada, aguardando o cliente", ratio=0.5),
           Table([[shot("10b-proposta-pdf.png", "PDF gerado", width=7.2 * cm, cell=True),
                   [P("<b>Lista de propostas</b>"), *shot("09-propostas.png", "Todas as propostas com status e valor", width=CONTENT_W - 8 * cm, ratio=0.45, cell=True)]]],
                 colWidths=[7.8 * cm, CONTENT_W - 7.8 * cm], style=[("VALIGN", (0, 0), (-1, -1), "TOP")]),
           tip("Os preços e tributos vêm sempre do catálogo, e o desconto máximo depende do papel (vendedor 10%, gerente 20%, administrador/proprietário 30%). Clicar duas vezes em \"Gerar\" não duplica a proposta."),
           PageBreak()]

    # 8, 9
    st += [P("8. Equipe", "h1"),
           P("Administradores convidam pessoas pelo e-mail e escolhem o papel. O convidado recebe um link válido por 7 dias (o link também aparece na tela, para copiar). Na lista é possível trocar o papel ou desativar alguém — o acesso cai na hora e a vaga do plano é liberada."),
           shot("11-equipe.png", "Equipe e convites pendentes", ratio=0.55),
           P("9. Assinatura", "h1"),
           P("Mostra o plano atual, a situação da conta e o uso (usuários e leads). O <b>Proprietário</b> clica em <b>Assinar</b> e é levado ao pagamento. Quando o teste acaba ou há bloqueio, esta tela continua acessível para regularizar."),
           shot("12-assinatura.png", "Planos: Starter (3 usuários, 1.000 leads), Pro (10 usuários) e Business (30 usuários)", ratio=0.55),
           PageBreak()]

    # 10
    st += [P("10. Painel da plataforma (equipe interna)", "h1"),
           P("Usado pela <b>nossa equipe</b> para acompanhar e controlar as empresas clientes, em <b>/admin</b>. Tem login próprio, separado do app dos clientes, e exige <b>MFA</b> (código do app autenticador)."),
           P("Primeiro acesso", "h2"),
           *steps("Um responsável técnico cria o seu acesso com o comando <b>platform:create-admin</b>.",
                  "O comando mostra um link <b>otpauth://</b> e uma chave: cadastre no Google Authenticator, Authy ou 1Password.",
                  "Guarde os <b>8 códigos de recuperação</b> em local seguro — cada um vale uma vez, se você perder o celular."),
           Table([[shot("13-admin-login.png", "Etapa 1: e-mail e senha", width=7.6 * cm, crop="auto", cell=True),
                   shot("14-admin-mfa.png", "Etapa 2: código de 6 dígitos", width=7.6 * cm, crop="auto", cell=True)]],
                 colWidths=[CONTENT_W / 2] * 2, style=[("VALIGN", (0, 0), (-1, -1), "TOP")]),
           shot("15-admin-clientes.png", "Clientes: MRR, status das contas e busca", ratio=0.5),
           PageBreak(),
           P("Detalhe do cliente e ações", "h2"),
           P("Abra um cliente para ver plano, uso, assinatura, usuários e auditoria recente. <b>Superadmins</b> podem <b>suspender/reativar</b>, <b>trocar o plano</b> e <b>estender o teste</b> — sempre informando o motivo, que fica registrado na auditoria. O papel <b>Suporte</b> só consulta."),
           shot("16-admin-cliente.png", "Detalhe do cliente com ações e auditoria", ratio=0.8),
           tip("Por privacidade (LGPD), o painel mostra só metadados de uso — não os leads nem as propostas dos clientes."),
           PageBreak(),
           P("Perguntas frequentes", "h1"),
           table([
               ["Esqueci a senha do app", "Esta versão (MVP) ainda não tem recuperação de senha por e-mail. Fale com o suporte da plataforma."],
               ["Aparece \"Muitas tentativas\"", "Por segurança, o login é bloqueado após várias tentativas. Aguarde alguns minutos."],
               ["Não consigo dar mais desconto", "O limite depende do seu papel. Peça a um gerente ou administrador."],
               ["\"Limite do plano atingido\"", "O plano chegou ao número máximo de usuários ou leads. O Proprietário pode trocar de plano em Assinatura."],
               ["Conta bloqueada (pagamento)", "O teste acabou ou há pendência. A tela de Assinatura continua disponível para regularizar."],
               ["Perdi o celular do autenticador (painel)", "Entre com um código de recuperação e peça para recriar seu MFA."],
           ], [5.2 * cm, CONTENT_W - 5.2 * cm], ["Situação", "O que fazer"])]

    doc = SimpleDocTemplate(str(OUT), pagesize=A4, leftMargin=2 * cm, rightMargin=2 * cm, topMargin=2 * cm, bottomMargin=1.8 * cm,
                            title="Gestão 360° — Guia rápido", author="Gestão 360°")
    doc.build(st, onFirstPage=header_footer, onLaterPages=header_footer)
    print(f"gerado: {OUT}")


if __name__ == "__main__":
    build()
