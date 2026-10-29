/* Aplica o tema salvo antes de desenhar a página (evita "piscar"). Padrão: escuro. */
try {
  var p = JSON.parse(localStorage.getItem('co_prefs') || '{}');
  document.documentElement.dataset.theme = p.tema === 'claro' ? 'light' : p.tema === 'auto' ? 'auto' : 'dark';
} catch (e) { document.documentElement.dataset.theme = 'dark'; }
