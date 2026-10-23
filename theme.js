/* Aplica o tema salvo antes de desenhar a página (evita "piscar") */
try {
  var p = JSON.parse(localStorage.getItem('co_prefs') || '{}');
  if (p.tema === 'claro') document.documentElement.dataset.theme = 'light';
  else if (p.tema === 'escuro') document.documentElement.dataset.theme = 'dark';
} catch (e) { /* sem preferências */ }
