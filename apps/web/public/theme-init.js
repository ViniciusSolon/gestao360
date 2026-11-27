// Aplica o tema salvo antes da primeira pintura (evita "piscar" claro/escuro).
// Padrão: Mirage (escuro). Arquivo separado porque a CSP do site bloqueia script inline.
(function () {
  var t = 'dark';
  try { if (localStorage.getItem('g360-theme') === 'light') t = 'light'; } catch (e) { /* sem armazenamento: escuro */ }
  document.documentElement.setAttribute('data-theme', t);
})();
