/* =========================================================================
   CONTROLE DE OBRAS — APLICATIVO (PWA)
   • Dados oficiais ficam no Google Drive (servidor Apps Script).
   • O aparelho guarda uma cópia (IndexedDB) e uma FILA de operações;
     sem internet, tudo é lançado normalmente e enviado depois.
   ========================================================================= */
'use strict';
const VERSAO_APP = '1.4.0 · edição tablet';
const FORMA_PEND = 'A pagar';   // forma de pagamento que deixa o item pendente até a baixa

/* =====================================================================
   NÚCLEO — regras de negócio (iguais às do servidor)
   ===================================================================== */
const CATS = {
  cliente:  {nome:'Valor pago pelo cliente', cor:'#0a7a3d'},
  enviado:  {nome:'Valor enviado',    cor:'#7a5c00'},
  mo:       {nome:'Mão de Obra',      cor:'#1565c0'},
  material: {nome:'Material',         cor:'#7b1fa2'},
  dia:      {nome:'Custos dia a dia', cor:'#b84300'},
  salario:  {nome:'Salário',          cor:'#00838f'},
  apagar:   {nome:'Valor a pagar',    cor:'#c62828'}
};
const CAT_ORDER = ['cliente','enviado','mo','material','dia','salario','apagar'];
const CAT_CUSTO = ['mo','material','dia','salario'];             // custos lançados
const CAT_TOTAL = ['mo','material','dia','salario','apagar'];    // custo total da obra
const CAT_PROPRIETARIO = ['cliente','enviado','mo','material','salario','apagar'];
const ORC_CATS = CAT_CUSTO;
const TIPOS = {enviado:['Adiantamento para custos','Reembolso recebido'], cliente:['Sinal / entrada','Medição','Parcela','Aditivo','Outros']};
const RE_PREVISTO = /Previsto em "A pagar"|\(previsto para /;
/** Item lançado para pagar depois (categoria "Valor a pagar" ou forma "A pagar"), pago ou não. */
const ehPrevistoAPagar = l => l.categoria==='apagar' || l.status==='Pendente' || l.forma==='A pagar' || !!l.venc || RE_PREVISTO.test(l.obs||'');
const ehPendente = l => !l.cancelado && l.status==='Pendente';
const PERFIL_NOME = {admin:'Administrador', engenheiro:'Engenheiro', proprietario:'Proprietário'};
const FMT_BRL = '"R$" #,##0.00;[Red]-"R$" #,##0.00';
const UN_DESC = {
  'vb':'verba', 'und':'unidade', 'pç':'peça', 'm':'metro linear', 'm²':'metro quadrado', 'm³':'metro cúbico',
  'kg':'quilograma', 't':'tonelada', 'saco':'saco (cimento, argamassa, cal)', 'mil':'milheiro (tijolo, bloco, telha)',
  'barra':'barra (aço, tubo, perfil)', 'rolo':'rolo (fio, cabo, manta, tela)', 'lata':'lata (tinta, 18 L)', 'galão':'galão (3,6 L)',
  'balde':'balde', 'L':'litro', 'cx':'caixa', 'pct':'pacote', 'par':'par', 'conj':'conjunto', 'dz':'dúzia',
  'tubo':'tubo/vara (6 m)', 'folha':'folha (chapa, compensado)', 'h':'hora', 'dia':'diária', 'mês':'mês',
  'viagem':'viagem / carrada', 'km':'quilômetro'
};

const round2 = n => Math.round(((+n)||0)*100 + (n>=0?1e-9:-1e-9))/100;
function parseNum(s){
  if (typeof s === 'number') return s;
  s = String(s ?? '').trim().replace(/\s|R\$/g,'');
  if (!s) return NaN;
  if (s.includes(',')) s = s.replace(/\./g,'').replace(',','.');          // 1.234,56 → 1234.56
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g,'');      // 120.000 → 120000 (ponto de milhar)
  return Number(s);
}
const fmtBRL = n => ((+n)||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const fmtNum = n => ((+n)||0).toLocaleString('pt-BR',{maximumFractionDigits:3});
function fmtData(iso){ if(!iso) return ''; const [y,m,d]=String(iso).slice(0,10).split('-'); return `${d}/${m}/${y}`; }
function fmtDataHora(iso){ if(!iso) return ''; const d=new Date(iso); return isNaN(d)?'':d.toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}); }
const mesRefDe = iso => iso ? iso.slice(0,7) : '';
function fmtMes(mr){ if(!mr) return ''; const [y,m]=mr.split('-'); return `${m}/${y}`; }
function isoToDate(iso){ const [y,m,d]=iso.split('-').map(Number); return new Date(y,m-1,d); }
function dateToIso(dt){ return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`; }
const hojeIso = () => dateToIso(new Date());
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g,c=>(c^crypto.getRandomValues(new Uint8Array(1))[0]&15>>c/4).toString(16)));
const clone = o => JSON.parse(JSON.stringify(o));

/* ---------------------------------------------------------------------
   Modelo financeiro (v1.3)
   • Custos lançados   = Mão de Obra + Material + Custos dia a dia + Salário
   • Custo total       = Custos lançados + "Valor a pagar" ainda sem categoria
   • Resultado atual   = Valor pago pelo cliente − Custos lançados
   • Lucro esperado    = Valor pago pelo cliente − Custo total
   • Valor a pagar (previsto) = tudo que foi lançado para pagar depois,
     separado em já pago e pendente — continua visível depois da baixa.
   --------------------------------------------------------------------- */
function totais(list){
  const t = {cliente:0,enviado:0,mo:0,material:0,dia:0,salario:0,apagar:0,adiant:0,reembRec:0,pend:0,diaPend:0,qPend:0,
    prevAPagar:0,pagoAPagar:0,qPrev:0,vencido:0,qVencido:0,qCliente:0};
  const hoje = hojeIso(); let prox = null;
  for (const l of list){
    if (l.cancelado) continue;
    const v = +l.total||0;
    t[l.categoria] = (t[l.categoria]||0) + v;
    if (l.categoria==='cliente') t.qCliente++;
    if (l.status==='Pendente'){
      t.pend += v; t.qPend++;
      if (l.categoria==='dia') t.diaPend += v;
      if (l.venc && (!prox || l.venc < prox.venc)) prox = l;
      if (l.venc && l.venc < hoje){ t.vencido += v; t.qVencido++; }
    }
    if (ehPrevistoAPagar(l)){ t.prevAPagar += v; t.qPrev++; if (l.status!=='Pendente') t.pagoAPagar += v; }
    if (l.categoria==='enviado'){ if (l.tipo==='Reembolso recebido') t.reembRec += v; else t.adiant += v; }
  }
  for (const k in t) if (!/^q/.test(k)) t[k] = round2(t[k]);
  t.proxVenc = prox ? prox.venc : '';
  t.reembolso = round2(t.dia - t.diaPend - t.enviado);   // custos dia a dia ainda "A pagar" não entram no reembolso
  t.custoLancado = round2(CAT_CUSTO.reduce((a,k)=>a+t[k],0));
  t.custoTotal = round2(t.custoLancado + t.apagar);
  t.total = t.custoTotal;
  t.resultadoAtual = round2(t.cliente - t.custoLancado);
  t.lucro = round2(t.cliente - t.custoTotal);
  t.margem = t.cliente > 0 ? t.lucro / t.cliente : null;
  t.situacao = t.lucro > 0.004 ? 'lucro' : t.lucro < -0.004 ? 'prejuizo' : 'equilibrio';
  return t;
}
const SITUACAO = {lucro:'Lucro', prejuizo:'Prejuízo', equilibrio:'Equilíbrio'};

/* ---------------------------------------------------------------------
   Equipe (v1.4): presença diária e pagamento das diárias em "Salário"
   --------------------------------------------------------------------- */
const FUNCOES = ['Mestre de obras','Encarregado','Pedreiro','Servente','Carpinteiro','Armador','Eletricista','Encanador','Pintor','Gesseiro',
  'Operador de máquina','Motorista','Vigia','Ajudante','Outros'];
const PRES = {'1':{rot:'Presente', curto:'P', cls:'p1'}, '0.5':{rot:'½ dia', curto:'½', cls:'p05'}, '0':{rot:'Falta', curto:'F', cls:'p0'}};
const valorDia = p => round2((+p.fracao||0) * (+p.diaria||0));
/** Quantidade, valor e observação do pagamento (mesma regra do servidor). */
function resumoDiarias(dias){
  let qtd = 0, total = 0; const vals = new Set();
  dias.forEach(p=>{ qtd += +p.fracao; total += (+p.fracao)*(+p.diaria); vals.add(+p.diaria); });
  qtd = Math.round(qtd*10)/10; total = round2(total);
  const lista = dias.map(p=>fmtData(p.data).slice(0,5) + (+p.fracao===0.5 ? ' (½)' : '')).join(', ');
  const uma = vals.size === 1;
  return {qtd: uma ? qtd : 1, vu: uma ? [...vals][0] : total, unidade: uma ? 'dia' : 'vb', total, dias: qtd,
    obs: ('Folha de diárias: ' + String(qtd).replace('.', ',') + ' dia(s) — ' + lista).slice(0,500)};
}
const descFolha = (f, ini, fim) => `Diárias — ${f.nome}${f.funcao?` (${f.funcao})`:''} — ${fmtData(ini).slice(0,5)} a ${fmtData(fim)}`;
function equipeTotais(obraId){
  const P = ((S && S.presencas) || []).filter(p=>p.obraId===obraId && +p.fracao>0), ap = P.filter(p=>!p.lancId);
  return {aPagar: round2(ap.reduce((s,p)=>s+valorDia(p),0)), diasAPagar: ap.reduce((s,p)=>s+(+p.fracao),0), funcAPagar: new Set(ap.map(p=>p.funcId)).size,
    pago: round2(P.filter(p=>p.lancId).reduce((s,p)=>s+valorDia(p),0)), dias: P.reduce((s,p)=>s+(+p.fracao),0),
    maisAntigo: ap.reduce((m,p)=>!m||p.data<m?p.data:m,'')};
}
const pct = x => (x==null || !isFinite(x)) ? '—' : (x*100).toLocaleString('pt-BR',{maximumFractionDigits:1}) + '%';

/** Contrato, orçamento, prazo e alertas da obra (sempre sobre a obra inteira). */
function analise(o, t, eq){
  const a = {alertas:[]}, orc = (o && o.orcamento) || {};
  const alerta = (nivel, texto) => a.alertas.push({nivel, texto});
  a.contrato = +(o && o.contrato) || 0; a.area = +(o && o.area) || 0;
  a.orcTotal = round2(ORC_CATS.reduce((s,k)=>s+(+orc[k]||0),0)); a.temOrc = a.orcTotal > 0;
  if (a.contrato > 0){
    a.aReceber = round2(a.contrato - t.cliente); a.pctRecebido = t.cliente / a.contrato;
    a.margemPrevista = a.temOrc ? round2(a.contrato - a.orcTotal) : null;
    a.margemProjetada = round2(a.contrato - Math.max(a.orcTotal, t.custoTotal));
  }
  if (a.temOrc){
    a.pctOrc = t.custoTotal / a.orcTotal; a.saldoOrc = round2(a.orcTotal - t.custoTotal);
    a.porCat = ORC_CATS.map(k=>({k, prev:+orc[k]||0, real:t[k], pct:(+orc[k]>0 ? t[k]/orc[k] : null)}));
  }
  if (a.area > 0){ a.custoM2 = t.custoTotal / a.area; if (a.temOrc) a.orcM2 = a.orcTotal / a.area; if (a.contrato) a.contratoM2 = a.contrato / a.area; }
  if (o && o.ini && o.fim && o.fim > o.ini){
    const ini = isoToDate(o.ini), fim = isoToDate(o.fim), h = isoToDate(hojeIso());
    a.pctPrazo = Math.min(1, Math.max(0, (h-ini)/(fim-ini))); a.diasRestantes = Math.round((fim-h)/864e5);
  }
  if (t.situacao==='prejuizo') alerta('crit', `Prejuízo esperado de ${fmtBRL(-t.lucro)}: o custo total da obra supera o valor pago pelo cliente.` +
    (a.contrato > 0 && a.aReceber > 0 ? ` Ainda faltam ${fmtBRL(a.aReceber)} a receber pelo contrato.` : ''));
  if (a.contrato > 0 && t.custoTotal > a.contrato) alerta('crit', `O custo total (${fmtBRL(t.custoTotal)}) já passou o valor do contrato (${fmtBRL(a.contrato)}).`);
  if (a.temOrc) a.porCat.forEach(c=>{
    if (c.pct===null) return;
    if (c.pct > 1) alerta('crit', `${CATS[c.k].nome} estourou o orçamento: ${pct(c.pct)} (${fmtBRL(c.real)} de ${fmtBRL(c.prev)}).`);
    else if (c.pct >= 0.9) alerta('aviso', `${CATS[c.k].nome} já usou ${pct(c.pct)} do orçamento (${fmtBRL(c.real)} de ${fmtBRL(c.prev)}).`);
  });
  if (a.temOrc && a.pctPrazo!=null && a.pctOrc - a.pctPrazo > 0.15)
    alerta('aviso', `Custos à frente do prazo: ${pct(a.pctOrc)} do orçamento gasto com ${pct(a.pctPrazo)} do prazo decorrido.`);
  if (t.qVencido) alerta('aviso', `${t.qVencido} pagamento(s) vencido(s), somando ${fmtBRL(t.vencido)}.`);
  if (a.diasRestantes!=null && a.diasRestantes < 0) alerta('aviso', `O prazo previsto terminou há ${-a.diasRestantes} dia(s).`);
  if (t.reembolso > 0.004) alerta('info', `Reembolso pendente ao engenheiro: ${fmtBRL(t.reembolso)}.`);
  if (eq && eq.aPagar > 0.004) alerta('info', `Diárias da equipe ainda não pagas: ${fmtBRL(eq.aPagar)} (${fmtNum(eq.diasAPagar)} dia(s) de ${eq.funcAPagar} funcionário(s), desde ${fmtData(eq.maisAntigo)}). Lance o pagamento na aba Equipe.`);
  if (t.situacao==='lucro' && !a.alertas.some(x=>x.nivel==='crit')) alerta('ok', `Lucro esperado de ${fmtBRL(t.lucro)} (${pct(t.margem)} do valor pago pelo cliente).`);
  return a;
}
function interpretaReemb(v){
  if (v > 0.004)  return 'A reembolsar ao engenheiro';
  if (v < -0.004) return 'Saldo em caixa com o engenheiro';
  return 'Quitado — sem saldo';
}
function grupoDe(iso, modo, periodos){
  if (modo==='personalizado'){
    const p = (periodos||[]).find(p => p.ini<=iso && iso<=p.fim);
    if (p) return {key:p.ini+'|'+p.id, nome:`${p.nome} (${fmtData(p.ini).slice(0,5)} – ${fmtData(p.fim)})`};
    return {key:'9999|fora', nome:'Fora dos períodos cadastrados'};
  }
  if (modo==='mes') return {key:iso.slice(0,7), nome:'Mês '+fmtMes(iso.slice(0,7))};
  if (modo==='quinzena'){ const q = +iso.slice(8,10) <= 15 ? 1 : 2; return {key:iso.slice(0,7)+'-'+q, nome:`${q}ª quinzena de ${fmtMes(iso.slice(0,7))}`}; }
  const dt = isoToDate(iso), dow = (dt.getDay()+6)%7;
  const ini = new Date(dt); ini.setDate(dt.getDate()-dow);
  const fim = new Date(ini); fim.setDate(ini.getDate()+6);
  const a = dateToIso(ini), b = dateToIso(fim);
  return {key:a, nome:`Semana ${fmtData(a).slice(0,5)} – ${fmtData(b)}`};
}
function agrupar(list, modo, periodos){
  const m = new Map();
  for (const l of list){ const g = grupoDe(l.data, modo, periodos); if (!m.has(g.key)) m.set(g.key, {...g, itens:[]}); m.get(g.key).itens.push(l); }
  return [...m.values()].sort((a,b)=> a.key<b.key ? -1 : 1);
}
const porData = (a,b) => (a.data||'').localeCompare(b.data||'') || String(a.criadoEm||'').localeCompare(String(b.criadoEm||''));

/* =====================================================================
   EXPORTAÇÃO EXCEL (relatório individual da obra)
   ===================================================================== */
function xlSerial(iso){ const [y,m,d]=iso.split('-').map(Number); return (Date.UTC(y,m-1,d)-Date.UTC(1899,11,30))/86400000; }
const XB = {style:'thin', color:{rgb:'BFBFBF'}};
const BORDA = {top:XB,bottom:XB,left:XB,right:XB};
const fill = rgb => ({patternType:'solid', fgColor:{rgb}});
const XS = {
  title:{font:{bold:true,sz:14,color:{rgb:'1F3864'}}}, info:{font:{italic:true,sz:10,color:{rgb:'595959'}}}, lbl:{font:{bold:true},border:BORDA},
  head:{font:{bold:true,color:{rgb:'FFFFFF'}},fill:fill('1F4E78'),alignment:{horizontal:'center',vertical:'center',wrapText:true},border:BORDA},
  txt:{border:BORDA}, num:{border:BORDA,alignment:{horizontal:'center'}}, date:{border:BORDA,alignment:{horizontal:'center'},numFmt:'dd/mm/yyyy'},
  money:{border:BORDA,numFmt:FMT_BRL}, pct:{border:BORDA,numFmt:'0.0%',alignment:{horizontal:'center'}},
  totLbl:{font:{bold:true},fill:fill('FFF2CC'),border:BORDA,alignment:{horizontal:'right'}}, totVal:{font:{bold:true},fill:fill('FFF2CC'),border:BORDA,numFmt:FMT_BRL},
  bloco:{font:{bold:true,color:{rgb:'1F3864'}},fill:fill('D9E1F2'),border:BORDA},
  grandLbl:{font:{bold:true,sz:12,color:{rgb:'FFFFFF'}},fill:fill('C55A11'),border:BORDA}, grand:{font:{bold:true,sz:12,color:{rgb:'FFFFFF'}},fill:fill('C55A11'),border:BORDA,numFmt:FMT_BRL}
};
const cT = (v,s=XS.txt) => ({t:'s', v:v==null?'':String(v), s});
const cN = (v,s=XS.num) => ({t:'n', v:+v||0, s});
const cM = (v,s=XS.money) => ({t:'n', v:round2(v), z:FMT_BRL, s});
const cD = (iso,s=XS.date) => iso ? {t:'n', v:xlSerial(iso), z:'dd/mm/yyyy', s} : cT('',s);
const cF = (f,v,s=XS.money) => ({t:'n', f, v:round2(v), z:FMT_BRL, s});
const cFs = (f,v,s=XS.txt) => ({t:'s', f, v:String(v), s});
const colL = i => XLSX.utils.encode_col(i);
function montarAba(M, larguras, merges){
  const ws = {}; let maxC = larguras.length-1;
  M.forEach((row,r)=>{ (row||[]).forEach((c,ci)=>{ if(!c) return; ws[XLSX.utils.encode_cell({r,c:ci})]=c; if(ci>maxC) maxC=ci; }); });
  ws['!ref'] = XLSX.utils.encode_range({s:{r:0,c:0}, e:{r:Math.max(M.length-1,0), c:maxC}});
  ws['!cols'] = larguras.map(w=>({wch:w}));
  if (merges && merges.length) ws['!merges'] = merges;
  return ws;
}
const G = { data:l=>l.data, doc:l=>l.doc, forn:l=>l.fornecedor, desc:l=>l.descricao, etapa:l=>l.etapa, forma:l=>l.forma, qtd:l=>l.qtd, un:l=>l.unidade,
  vu:l=>l.vu, mes:l=>fmtMes(l.mesRef), obs:l=>l.obs, sub:l=>l.subcat, status:l=>l.status, venc:l=>l.venc, tipo:l=>l.tipo, total:l=>l.total,
  por:l=>nomeUsuario(l.criadoPor), comp:l=>l.comprovanteId?'Sim':'', catNome:l=>CATS[l.categoria]?CATS[l.categoria].nome:l.categoria };
const TIPO = {data:'date',venc:'date',qtd:'num',vu:'money'};
const col = (h,k,w) => ({h,k,w,t:TIPO[k]||'txt',get:G[k]});
function abaSimples(nome, titulo, info, cols, itens){
  const tc = cols.findIndex(c=>c.k==='total'), qc = cols.findIndex(c=>c.k==='qtd'), vc = cols.findIndex(c=>c.k==='vu');
  const R0 = 5, RN = R0 + itens.length - 1;
  const soma = round2(itens.reduce((a,l)=>a+(+l.total||0),0));
  const r3 = []; r3[tc-1] = cT('TOTAL', XS.totLbl);
  r3[tc] = itens.length ? cF(`SUBTOTAL(9,${colL(tc)}${R0}:${colL(tc)}${RN})`, soma, XS.totVal) : cM(0, XS.totVal);
  const M = [[cT(titulo,XS.title)], [cT(info,XS.info)], r3, cols.map(c=>cT(c.h,XS.head))];
  itens.forEach((l,i)=>{ const r = R0+i; M.push(cols.map(c=>{
    if (c.k==='total') return cF(`${colL(qc)}${r}*${colL(vc)}${r}`, l.total);
    const v = c.get(l); return c.t==='date' ? cD(v) : c.t==='money' ? cM(v) : c.t==='num' ? cN(v) : cT(v); })); });
  const last = cols.length-1;
  const ws = montarAba(M, cols.map(c=>c.w), [{s:{r:0,c:0},e:{r:0,c:last}},{s:{r:1,c:0},e:{r:1,c:last}}]);
  if (itens.length) ws['!autofilter'] = {ref:`A4:${colL(last)}${RN}`};
  return {ws, ref:`'${nome}'!${colL(tc)}3`, soma, R0, RN};
}
function abaCustos(nome, titulo, info, itens, modo, periodos){
  const cols = [col('Data','data',11),col('Nº NF / Recibo','doc',14),col('Fornecedor','forn',26),col('Descrição do item / serviço','desc',32),
    col('Subcategoria','sub',24),col('Etapa da obra','etapa',16),col('Qtd.','qtd',7),col('Unid.','un',7),col('Valor unitário (R$)','vu',15),
    col('Valor total (R$)','total',16),col('Forma de pagamento','forma',14),col('Comprovante','comp',12),col('Mês ref.','mes',9),col('Lançado por','por',18),col('Observações','obs',30),col('Situação','status',10),col('Vencimento','venc',11)];
  const TC = 9, last = cols.length-1, J = colL(TC);
  const M = [[cT(titulo,XS.title)], [cT(info,XS.info)], [], []];
  const merges = [{s:{r:0,c:0},e:{r:0,c:last}},{s:{r:1,c:0},e:{r:1,c:last}}];
  const grupos = modo==='nenhum' ? (itens.length?[{nome:'Todos os lançamentos',itens}]:[]) : agrupar(itens, modo, periodos);
  const totRefs = []; let firstData = null, lastData = null;
  for (const g of grupos){
    merges.push({s:{r:M.length,c:0},e:{r:M.length,c:last}});
    M.push([cT(g.nome.toUpperCase(), XS.bloco)]); M.push(cols.map(c=>cT(c.h,XS.head)));
    const ini = M.length+1;
    for (const l of g.itens){ const r = M.length+1; M.push(cols.map(c=>{
      if (c.k==='total') return cF(`G${r}*I${r}`, l.total);
      const v = c.get(l); return c.t==='date' ? cD(v) : c.t==='money' ? cM(v) : c.t==='num' ? cN(v) : cT(v); })); }
    const fim = M.length; if (firstData===null) firstData = ini; lastData = fim;
    const sub = round2(g.itens.reduce((a,l)=>a+(+l.total||0),0));
    const tr = []; tr[TC-1] = cT('TOTAL',XS.totLbl); tr[TC] = cF(`SUM(${J}${ini}:${J}${fim})`, sub, XS.totVal);
    M.push(tr); totRefs.push(`${J}${M.length}`); M.push([]);
  }
  const soma = round2(itens.reduce((a,l)=>a+(+l.total||0),0));
  M[2][TC-1] = cT('TOTAL GERAL', XS.grandLbl);
  M[2][TC] = totRefs.length ? cF(totRefs.join('+'), soma, XS.grand) : cM(0, XS.grand);
  const subs = [...new Set(itens.map(l=>l.subcat||'Outros'))].sort();
  if (subs.length){
    M.push([]);
    const rh = []; rh[3] = cT('RESUMO POR SUBCATEGORIA', XS.bloco); M.push(rh);
    const hh = []; hh[3] = cT('Subcategoria',XS.head); hh[TC] = cT('Valor (R$)',XS.head); hh[TC+1] = cT('% do total',XS.head); M.push(hh);
    for (const s of subs){
      const r = M.length+1, v = round2(itens.filter(l=>(l.subcat||'Outros')===s).reduce((a,l)=>a+(+l.total||0),0));
      const row = []; row[3] = cT(s, XS.lbl);
      row[TC] = cF(`SUMIF(E${firstData}:E${lastData},D${r},${J}${firstData}:${J}${lastData})`, v);
      row[TC+1] = {t:'n', f:`IF($${J}$3=0,0,${J}${r}/$${J}$3)`, v: soma? v/soma : 0, z:'0.0%', s:XS.pct};
      M.push(row);
    }
  }
  return {ws: montarAba(M, cols.map(c=>c.w), merges), ref:`'${nome}'!${J}3`, soma};
}
function construirWorkbook(obra, L, agrupamento, periodos, eq){
  const wb = XLSX.utils.book_new();
  const gerado = new Date().toLocaleString('pt-BR');
  const info = `Obra: ${obra.nome}${obra.cidade?' — '+obra.cidade:''}  |  Gerado em ${gerado} por ${S.usuario.nome}`;
  const de = k => L.filter(l=>l.categoria===k).sort(porData);
  const t = totais(L), a = analise(obra, t);
  const comuns = [col('Forma de pagamento','forma',14),col('Qtd.','qtd',7),col('Unid.','un',7),col('Valor unitário (R$)','vu',15),col('Valor total (R$)','total',16),col('Mês ref.','mes',9),col('Comprovante','comp',12),col('Lançado por','por',18),col('Observações','obs',30),col('Situação','status',10),col('Vencimento','venc',11)];
  const cli = abaSimples('Recebido do cliente','VALOR PAGO PELO CLIENTE',info,[col('Data','data',11),col('Nº NF / Recibo / Medição','doc',16),col('Tipo','tipo',18),col('Pagador','forn',26),col('Descrição','desc',34),...comuns], de('cliente'));
  const env = abaSimples('Valor enviado','VALOR ENVIADO PELO PROPRIETÁRIO',info,[col('Data','data',11),col('Nº documento','doc',14),col('Tipo','tipo',24),col('Origem do recurso','forn',26),col('Descrição','desc',34),...comuns], de('enviado'));
  const mo  = abaSimples('Mão de Obra','MÃO DE OBRA',info,[col('Data','data',11),col('Nº documento','doc',14),col('Beneficiário','forn',24),col('Descrição','desc',34),col('Etapa da obra','etapa',16),...comuns], de('mo'));
  const mat = abaSimples('Material','MATERIAL',info,[col('Data','data',11),col('Nº NF / Recibo','doc',14),col('Fornecedor','forn',24),col('Material','desc',34),col('Etapa da obra','etapa',16),...comuns], de('material'));
  const dia = abaCustos('Custos dia a dia','CUSTOS DIA A DIA',info, de('dia'), agrupamento||'semana', periodos);
  const sal = abaSimples('Salário','SALÁRIO — ENGENHEIRO E DIÁRIAS DA EQUIPE',info,[col('Data','data',11),col('Nº documento','doc',14),col('Beneficiário / origem','forn',24),col('Descrição','desc',40),...comuns], de('salario'));
  // "A pagar": tudo que foi lançado para pagar depois — pago ou pendente. Colunas C (categoria), J (total) e K (situação) são usadas nas fórmulas.
  const prev = L.filter(ehPrevistoAPagar).sort((x,y)=>(x.venc||x.data||'').localeCompare(y.venc||y.data||''));
  const pag = abaSimples('A pagar','VALORES A PAGAR (PREVISTOS) — PAGOS E PENDENTES',info,[col('Data','data',11),col('Vencimento','venc',11),col('Categoria atual','catNome',18),
    col('Fornecedor / Beneficiário','forn',24),col('Descrição','desc',36),col('Etapa da obra','etapa',16),col('Qtd.','qtd',7),col('Unid.','un',7),col('Valor unitário (R$)','vu',15),
    col('Valor total (R$)','total',16),col('Situação','status',10),col('Forma','forma',12),col('Lançado por','por',18),col('Observações','obs',34)], prev);
  const semCat = `SUMIF('A pagar'!C:C,"${CATS.apagar.nome}",'A pagar'!J:J)`;
  // Reembolso (inalterado). Colunas C (Tipo) e J (Valor total) da aba "Valor enviado".
  const rng = env.RN>=env.R0 ? [`'Valor enviado'!C${env.R0}:C${env.RN}`, `'Valor enviado'!J${env.R0}:J${env.RN}`] : null;
  const RM = [
    [cT('DEMONSTRATIVO DE REEMBOLSO',XS.title)], [cT(info,XS.info)], [],
    [cT('Item',XS.head), cT('Valor (R$)',XS.head)],
    [cT('Custos dia a dia já pagos',XS.lbl), cF(`${dia.ref}-SUMIF('Custos dia a dia'!P:P,"Pendente",'Custos dia a dia'!J:J)`, t.dia - t.diaPend)],
    [cT('(−) Total do valor enviado',XS.lbl), cF(env.ref, t.enviado)],
    [cT('      dos quais: reembolsos recebidos',XS.txt), rng ? cF(`SUMIF(${rng[0]},"Reembolso recebido",${rng[1]})`, t.reembRec) : cM(0)],
    [cT('      dos quais: adiantamentos para custos',XS.txt), cF('B6-B7', t.adiant)],
    [cT('SALDO (Custos dia a dia − Valor enviado)',XS.grandLbl), cF('B5-B6', t.reembolso, XS.grand)],
    [cT('Situação',XS.lbl), cFs('IF(B9>0.004,"A reembolsar ao engenheiro",IF(B9<-0.004,"Saldo em caixa com o engenheiro","Quitado — sem saldo"))', interpretaReemb(t.reembolso), XS.lbl)],
    [cT('Valor absoluto do saldo',XS.lbl), cF('ABS(B9)', Math.abs(t.reembolso))],
    [], [cT('Saldo positivo: o proprietário deve reembolsar o engenheiro. Saldo negativo: há recurso em poder do engenheiro.',XS.info)],
    [cT(`Custos dia a dia com forma "A pagar" ainda pendentes (${fmtBRL(t.diaPend)}) entram no reembolso depois de pagos.`,XS.info)]
  ];
  const reemb = montarAba(RM,[46,22],[{s:{r:0,c:0},e:{r:0,c:1}},{s:{r:1,c:0},e:{r:1,c:1}}]);

  // ---------- Resultado ----------
  const R = [[cT('RESULTADO DA OBRA',XS.title)], [cT(info,XS.info)], [],
    [cT('Demonstrativo do resultado',XS.head), cT('Valor (R$)',XS.head), cT('% do custo total',XS.head)]];
  const linha = (rotulo, cel, estilo) => { R.push([cT(rotulo, estilo||XS.lbl), cel]); return R.length; };
  const rCli = linha('(+) Valor pago pelo cliente', cF(cli.ref, t.cliente));
  const rMo  = linha('(−) Mão de Obra', cF(mo.ref, t.mo));
  const rMat = linha('(−) Material', cF(mat.ref, t.material));
  const rDia = linha('(−) Custos dia a dia', cF(dia.ref, t.dia));
  const rSal = linha('(−) Salário', cF(sal.ref, t.salario));
  const rRes = linha('(=) Resultado atual (sem os valores a pagar)', cF(`B${rCli}-SUM(B${rMo}:B${rSal})`, t.resultadoAtual), XS.totLbl);
  const rPag = linha('(−) Valor a pagar ainda sem categoria', cF(semCat, t.apagar));
  const rLuc = linha('(=) LUCRO ESPERADO', cF(`B${rRes}-B${rPag}`, t.lucro, XS.grand), XS.grandLbl);
  const rCT  = linha('Custo total da obra', cF(`SUM(B${rMo}:B${rSal})+B${rPag}`, t.custoTotal, XS.totVal), XS.totLbl);
  R.push([cT('Situação',XS.lbl), cFs(`IF(B${rLuc}>0.004,"LUCRO",IF(B${rLuc}<-0.004,"PREJUÍZO","EQUILÍBRIO"))`, SITUACAO[t.situacao].toUpperCase(), XS.lbl)]); const rSit = R.length;
  R.push([cT('Margem sobre o valor pago pelo cliente',XS.lbl), {t:'n', f:`IF(B${rCli}=0,0,B${rLuc}/B${rCli})`, v:t.margem||0, z:'0.0%', s:XS.pct}]);
  [[rMo,t.mo],[rMat,t.material],[rDia,t.dia],[rSal,t.salario],[rPag,t.apagar]].forEach(([r,v])=>{ R[r-1][2] = {t:'n', f:`IF($B$${rCT}=0,0,B${r}/$B$${rCT})`, v:t.custoTotal? v/t.custoTotal : 0, z:'0.0%', s:XS.pct}; });
  R.push([], [cT('Valores a pagar (previstos)',XS.head), cT('Valor (R$)',XS.head)]);
  linha('Total lançado para pagar depois', cF(pag.ref, t.prevAPagar));
  linha('Já pago', cF(`SUMIF('A pagar'!K:K,"Pago",'A pagar'!J:J)`, t.pagoAPagar));
  linha('Pendente', cF(`SUMIF('A pagar'!K:K,"Pendente",'A pagar'!J:J)`, t.pend));
  if (a.contrato > 0){
    R.push([], [cT('Contrato',XS.head), cT('Valor (R$)',XS.head)]);
    const rCon = linha('Valor do contrato', cM(a.contrato));
    linha('Recebido do cliente', cF(`B${rCli}`, t.cliente));
    linha('A receber', cF(`B${rCon}-B${rCli}`, a.aReceber));
    R.push([cT('% recebido',XS.lbl), {t:'n', f:`IF(B${rCon}=0,0,B${rCli}/B${rCon})`, v:a.pctRecebido, z:'0.0%', s:XS.pct}]);
    if (a.temOrc) linha('Margem prevista (contrato − orçamento)', cM(a.margemPrevista));
    linha('Margem projetada (contrato − maior entre orçamento e custo total)', cM(a.margemProjetada));
  }
  if (a.temOrc){
    R.push([], [cT('Orçamento × realizado',XS.head), cT('Previsto (R$)',XS.head), cT('Realizado (R$)',XS.head), cT('% usado',XS.head), cT('Saldo (R$)',XS.head)]);
    const r0 = R.length + 1;
    a.porCat.forEach((c,i)=>{ const r = R.length + 1, ref = [rMo,rMat,rDia,rSal][i];
      R.push([cT(CATS[c.k].nome,XS.lbl), cM(c.prev), cF(`B${ref}`, c.real), {t:'n', f:`IF(B${r}=0,0,C${r}/B${r})`, v:c.pct||0, z:'0.0%', s:XS.pct}, cF(`B${r}-C${r}`, c.prev-c.real)]); });
    const r1 = R.length, rt = R.length + 1;
    R.push([cT('TOTAL',XS.totLbl), cF(`SUM(B${r0}:B${r1})`, a.orcTotal, XS.totVal), cF(`SUM(C${r0}:C${r1})+B${rPag}`, t.custoTotal, XS.totVal),
      {t:'n', f:`IF(B${rt}=0,0,C${rt}/B${rt})`, v:a.pctOrc||0, z:'0.0%', s:XS.pct}, cF(`B${rt}-C${rt}`, a.saldoOrc, XS.totVal)]);
    R.push([cT('O total realizado inclui os valores a pagar ainda sem categoria.',XS.info)]);
  }
  if (a.area > 0){
    R.push([], [cT('Indicadores por m²',XS.head), cT('R$/m²',XS.head)]);
    R.push([cT(`Área: ${fmtNum(a.area)} m²`,XS.info)]);
    linha('Custo total por m²', cF(`B${rCT}/${a.area}`, a.custoM2));
    if (a.temOrc) linha('Orçamento por m²', cM(a.orcM2));
    if (a.contrato > 0) linha('Contrato por m²', cM(a.contratoM2));
  }
  R.push([], [cT('Resultado atual = Valor pago pelo cliente − (Mão de Obra + Material + Custos dia a dia + Salário).',XS.info)],
    [cT('Lucro esperado = Valor pago pelo cliente − Custo total da obra (inclui os valores a pagar ainda sem categoria).',XS.info)]);
  const resultado = montarAba(R,[52,18,16,12,16],[{s:{r:0,c:0},e:{r:0,c:4}},{s:{r:1,c:0},e:{r:1,c:4}}]);

  // ---------- Início ----------
  const IM = [[cT(`CONTROLE DE GASTOS — ${obra.nome.toUpperCase()}`,XS.title)],
    [cT('Cidade/UF',XS.lbl), cT(obra.cidade||'')], [cT('Proprietário / Contratante',XS.lbl), cT(obra.prop||'')],
    [cT('Engenheiro responsável',XS.lbl), cT(obra.eng||'')], [cT('Início / término previsto',XS.lbl), cT([fmtData(obra.ini), fmtData(obra.fim)].filter(Boolean).join(' — '))],
    [cT('Gerado em',XS.lbl), cT(`${gerado} — ${S.usuario.nome}`)], [],
    [cT('Categoria',XS.head), cT('Valor (R$)',XS.head), cT('% do custo total',XS.head)]];
  const rIniCT = IM.length + 8;   // linha do CUSTO TOTAL (ver ordem abaixo)
  const pctCel = (r,v) => ({t:'n', f:`IF($B$${rIniCT}=0,0,B${r}/$B$${rIniCT})`, v:t.custoTotal? v/t.custoTotal:0, z:'0.0%', s:XS.pct});
  const add = (rot, cel, terc, est) => { IM.push([cT(rot, est||XS.lbl), cel, terc]); return IM.length; };
  add('Valor pago pelo cliente', cF(cli.ref, t.cliente), cT('receita — não compõe o custo',XS.info));
  add('Valor enviado', cF(env.ref, t.enviado), cT('caixa do engenheiro — não compõe o custo',XS.info));
  [['Mão de Obra', mo.ref, t.mo], ['Material', mat.ref, t.material], ['Custos dia a dia', dia.ref, t.dia], ['Salário', sal.ref, t.salario]]
    .forEach(([n,ref,v])=>{ const r = IM.length + 1; add(n, cF(ref, v), pctCel(r, v)); });
  { const r = IM.length + 1; add('Valor a pagar (sem categoria)', cF(`'Resultado'!B${rPag}`, t.apagar), pctCel(r, t.apagar)); }
  const rCTi = add('CUSTO TOTAL DA OBRA', cF(`SUM(B${rIniCT-5}:B${rIniCT-1})`, t.custoTotal, XS.grand), cT('',XS.grandLbl), XS.grandLbl);
  add('LUCRO ESPERADO', cF(`'Resultado'!B${rLuc}`, t.lucro, XS.totVal), cFs(`'Resultado'!B${rSit}`, SITUACAO[t.situacao].toUpperCase(), XS.lbl), XS.totLbl);
  add('Resultado atual (sem os valores a pagar)', cF(`'Resultado'!B${rRes}`, t.resultadoAtual), cT('',XS.txt));
  add('Valor de reembolso', cF("'Reembolso'!B9", t.reembolso), cFs("'Reembolso'!B10", interpretaReemb(t.reembolso), XS.txt));
  IM.push([], [cT('Valores a pagar (previstos)',XS.lbl), cM(t.prevAPagar), cT(`já pago ${fmtBRL(t.pagoAPagar)} · pendente ${fmtBRL(t.pend)}${t.proxVenc?' · próximo vencimento '+fmtData(t.proxVenc):''}`,XS.txt)]);
  if (a.alertas.length){ IM.push([], [cT('ALERTAS',XS.bloco)]); a.alertas.forEach(x=>IM.push([cT(x.texto,XS.txt)])); }
  IM.push([], [cT('Custo total = Mão de Obra + Material + Custos dia a dia + Salário + Valor a pagar sem categoria.',XS.info)],
    [cT('Lucro esperado = Valor pago pelo cliente − Custo total. Lançamentos cancelados não entram no relatório.',XS.info)]);
  if (rCTi !== rIniCT) throw new Error('Início: linha do custo total fora do lugar');
  const inicio = montarAba(IM,[40,22,40],[{s:{r:0,c:0},e:{r:0,c:2}}]);
  const abas = [['Início',inicio],['Resultado',resultado],['Recebido do cliente',cli.ws],['Valor enviado',env.ws],['Mão de Obra',mo.ws],['Material',mat.ws],
   ['Custos dia a dia',dia.ws],['Salário',sal.ws]];
  if (eq && eq.func.length) abas.push(['Equipe', abaEquipe(info, eq, L)]);
  abas.push(['A pagar',pag.ws],['Reembolso',reemb]);
  abas.forEach(([n,ws])=>XLSX.utils.book_append_sheet(wb, ws, n));
  return wb;
}

/** Aba "Equipe": resumo por funcionário + registro diário de presença (valor = fração × diária). */
function abaEquipe(info, eq, L){
  const stLanc = new Map(L.filter(l=>!l.cancelado).map(l=>[l.id, l.status]));
  const pago = p => p.lancId && stLanc.has(p.lancId);
  const sitDia = p => !pago(p) ? 'A pagar' : stLanc.get(p.lancId)==='Pendente' ? 'Lançado (pagamento pendente)' : 'Pago';
  const nomeF = id => (eq.func.find(f=>f.id===id)||{}).nome || '';
  const funcF = id => (eq.func.find(f=>f.id===id)||{}).funcao || '';
  const M = [[cT('EQUIPE E PRESENÇA DIÁRIA',XS.title)], [cT(info,XS.info)], [],
    ['Funcionário','Função','Diária atual (R$)','Dias trabalhados','Valor trabalhado (R$)','Lançado em Salário (R$)','A pagar (R$)','PIX','Telefone','Situação'].map(h=>cT(h,XS.head))];
  const f0 = M.length + 1;
  eq.func.slice().sort((a,b)=>a.nome.localeCompare(b.nome,'pt-BR')).forEach(f=>{
    const P = eq.pres.filter(p=>p.funcId===f.id && +p.fracao>0);
    const vt = round2(P.reduce((s,p)=>s+valorDia(p),0)), vp = round2(P.filter(pago).reduce((s,p)=>s+valorDia(p),0)), r = M.length + 1;
    M.push([cT(f.nome,XS.lbl), cT(f.funcao||''), cM(f.diaria), cN(P.reduce((s,p)=>s+(+p.fracao),0)), cM(vt), cM(vp), cF(`E${r}-F${r}`, vt-vp), cT(f.pix||''), cT(f.telefone||''), cT(f.ativo===false?'Inativo':'Ativo')]);
  });
  const f1 = M.length, rt = M.length + 1;
  const tot = c => eq.func.length ? cF(`SUM(${c}${f0}:${c}${f1})`, 0, XS.totVal) : cM(0, XS.totVal);
  const tr = [cT('TOTAL',XS.totLbl), cT('',XS.totLbl), cT('',XS.totLbl), {t:'n', f:`SUM(D${f0}:D${f1})`, v:0, s:XS.totVal}, tot('E'), tot('F'), tot('G')];
  M.push(tr);
  M.push([], [cT('REGISTRO DE PRESENÇA (P = presente, ½ = meio dia, F = falta)',XS.bloco)],
    ['Data','Funcionário','Função','Presença','Fração do dia','Diária (R$)','Valor (R$)','Situação','Observação'].map(h=>cT(h,XS.head)));
  const p0 = M.length + 1;
  const reg = eq.pres.slice().sort((a,b)=>a.data.localeCompare(b.data) || nomeF(a.funcId).localeCompare(nomeF(b.funcId),'pt-BR'));
  reg.forEach(p=>{ const r = M.length + 1;
    M.push([cD(p.data), cT(nomeF(p.funcId)), cT(funcF(p.funcId)), cT((PRES[String(+p.fracao)]||{}).rot||''), {t:'n', v:+p.fracao, s:XS.num}, cM(p.diaria),
      cF(`E${r}*F${r}`, valorDia(p)), cT(+p.fracao>0 ? sitDia(p) : '—'), cT(p.obs||'')]); });
  // valores em cache dos totais do resumo
  const somaCol = i => round2(M.slice(f0-1, f1).reduce((s,row)=>s+(+(row[i]&&row[i].v)||0),0));
  tr[3].v = somaCol(3); tr[4].v = somaCol(4); tr[5].v = somaCol(5); tr[6].v = somaCol(6);
  const ws = montarAba(M,[26,18,14,12,16,14,14,22,16,10],[{s:{r:0,c:0},e:{r:0,c:9}},{s:{r:1,c:0},e:{r:1,c:9}}]);
  if (reg.length) ws['!autofilter'] = {ref:`A${p0-1}:I${M.length}`};
  return ws;
}

/* =====================================================================
   ARMAZENAMENTO LOCAL (IndexedDB)
   ===================================================================== */
const kv = {
  db: null,
  abrir(){ return new Promise((ok, falha)=>{ const r = indexedDB.open('controleObras', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => { this.db = r.result; ok(); }; r.onerror = () => falha(r.error); }); },
  get(k){ return new Promise((ok, falha)=>{ const r = this.db.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => ok(r.result); r.onerror = () => falha(r.error); }); },
  set(k, v){ return new Promise((ok, falha)=>{ const tx = this.db.transaction('kv','readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = () => ok(); tx.onerror = () => falha(tx.error); }); },
  del(k){ return new Promise((ok)=>{ const tx = this.db.transaction('kv','readwrite'); tx.objectStore('kv').delete(k); tx.oncomplete = () => ok(); }); }
};
let PREFS = {};
function lerPrefs(){ try { PREFS = JSON.parse(localStorage.getItem('co_prefs')||'{}'); } catch(e){ PREFS = {}; } }
function salvarPrefs(){ try { localStorage.setItem('co_prefs', JSON.stringify(PREFS)); } catch(e){ /* sem armazenamento */ } }

/* =====================================================================
   SESSÃO, SERVIDOR E SINCRONIZAÇÃO
   ===================================================================== */
let CONF = {};          // {api}
let SESSAO = null;      // {token, usuario}
let BASE = null;        // último retrato vindo do servidor
let S = null;           // estado exibido = BASE + operações pendentes
let FILA = [];          // operações aguardando envio
let REJ = [];           // operações recusadas pelo servidor
let sincronizando = false, ultimoErroSync = '', ultimoSyncOk = 0;

class ErroRede extends Error {}
async function api(acao, dados, semToken){
  if (window.__DEMO__) return window.__DEMO__.api(acao, dados||{});
  if (!CONF.api) throw new Error('Servidor não configurado.');
  let r;
  try {
    r = await fetch(CONF.api, { method:'POST', headers:{'Content-Type':'text/plain;charset=utf-8'}, redirect:'follow', cache:'no-store',
      body: JSON.stringify({acao, dados: dados||{}, token: semToken ? undefined : SESSAO && SESSAO.token}) });
  } catch(e){ throw new ErroRede('Sem conexão com o servidor.'); }
  if (!r.ok) throw new ErroRede('O servidor respondeu com erro ' + r.status + '.');
  let j; try { j = await r.json(); } catch(e){ throw new ErroRede('Resposta inválida do servidor. Confira o endereço.'); }
  if (!j.ok){ const e = new Error(j.erro || 'Erro no servidor.'); e.codigo = j.codigo; throw e; }
  return j;
}

function reconstruir(){
  S = BASE ? clone(BASE) : {usuario:SESSAO.usuario, cfg:{formas:['PIX'],unidades:['vb'],subcats:['Outros'],etapas:[]}, obras:[], lanc:[], periodos:[], nomes:{}};
  S.func = S.func || []; S.presencas = S.presencas || [];
  S.usuario = SESSAO.usuario;
  for (const op of FILA) aplicarLocal(op);
}

function aplicarLocal(op){
  const d = op.dados || {};
  const achar = (arr, id) => arr.find(x=>x.id===id);
  switch (op.tipo){
    case 'obra.salvar': {
      const campos = {nome:d.nome, cidade:d.cidade, prop:d.prop, eng:d.eng, ini:d.ini};
      ['contrato','area','fim','orcamento'].forEach(k=>{ if (k in d) campos[k] = d[k]; });
      const o = achar(S.obras, d.id);
      if (o) Object.assign(o, campos, {_pend:true}); else S.obras.push({id:d.id, ...campos, _pend:true});
      break; }
    case 'obra.arquivar': S.obras = S.obras.filter(o=>o.id!==d.id); break;
    case 'lanc.salvar': {
      const rec = {...d, vu:round2(d.vu), total:round2(d.qtd*round2(d.vu)), status:(d.categoria==='apagar'||d.forma===FORMA_PEND)?'Pendente':'Pago', _pend:true};
      if (d.categoria!=='dia') rec.subcat=''; if (!TIPOS[d.categoria]) rec.tipo=''; if (rec.status!=='Pendente') rec.venc='';
      const l = achar(S.lanc, d.id);
      if (l) Object.assign(l, rec);
      else S.lanc.push({...rec, comprovanteId:'', criadoPor:S.usuario.id, criadoEm:new Date(op.criadoEm).toISOString(), cancelado:false, motivoCancel:''});
      break; }
    case 'lanc.cancelar': { const l = achar(S.lanc, d.id); if (l) Object.assign(l, {cancelado:true, motivoCancel:d.motivo, _pend:true});
      if (l && l.categoria==='salario') S.presencas.forEach(p=>{ if (p.lancId===l.id){ p.lancId=''; p._pend=true; } }); break; }
    case 'lanc.pagar': { const l = achar(S.lanc, d.id);
      if (l && l.categoria!=='apagar' && l.forma===FORMA_PEND && l.status==='Pendente'){
        const nota = `Pago em ${fmtData(d.data)} via ${d.forma} (previsto para ${fmtData(l.venc)})`;
        Object.assign(l, {forma:d.forma, status:'Pago', obs:l.obs?l.obs+' | '+nota:nota, _pend:true}); break; }
      if (l && l.categoria==='apagar'){
      const nota = `Previsto em "A pagar" (venc. ${fmtData(l.venc)})`;
      Object.assign(l, {categoria:d.categoria, data:d.data, forma:d.forma, status:'Pago', subcat:d.categoria==='dia'?d.subcat:'', mesRef:mesRefDe(d.data), obs:l.obs?l.obs+' | '+nota:nota, _pend:true}); } break; }
    case 'periodo.salvar': { const p = achar(S.periodos, d.id); if (p) Object.assign(p, d); else S.periodos.push({...d}); break; }
    case 'periodo.excluir': S.periodos = S.periodos.filter(p=>p.id!==d.id); break;
    case 'comprovante.enviar': { const l = achar(S.lanc, d.lancId); if (l){ l._compPend = op.opId; l._pend = true; } break; }
    case 'func.salvar': {
      const campos = {nome:d.nome, funcao:d.funcao||'', diaria:round2(d.diaria), pix:d.pix||'', telefone:d.telefone||'', ativo:d.ativo!==false, _pend:true};
      const f = achar(S.func, d.id);
      if (f) Object.assign(f, campos); else S.func.push({id:d.id, obraId:d.obraId, ...campos, criadoEm:new Date(op.criadoEm).toISOString()});
      break; }
    case 'presenca.salvar': {
      for (const it of d.itens||[]){
        const f = achar(S.func, it.funcId); if (!f) continue;
        const fr = +it.fracao, p = S.presencas.find(x=>x.obraId===d.obraId && x.funcId===it.funcId && x.data===d.data);
        if (p){ if (p.lancId) continue; Object.assign(p, {fracao:fr, obs:it.obs||'', diaria: fr ? (+p.diaria||f.diaria) : f.diaria, _pend:true}); }
        else S.presencas.push({id:'tmp-'+op.opId+'-'+it.funcId, obraId:d.obraId, funcId:it.funcId, data:d.data, fracao:fr, diaria:f.diaria, obs:it.obs||'', lancId:'', _pend:true});
      }
      break; }
    case 'folha.gerar': {
      for (const it of d.itens||[]){
        if (achar(S.lanc, it.lancId)) continue;
        const f = achar(S.func, it.funcId); if (!f) continue;
        const dias = S.presencas.filter(p=>p.obraId===d.obraId && p.funcId===f.id && !p.lancId && +p.fracao>0 && p.data>=d.ini && p.data<=d.fim).sort((a,b)=>a.data.localeCompare(b.data));
        if (!dias.length) continue;
        const r = resumoDiarias(dias), pend = d.forma===FORMA_PEND;
        S.lanc.push({id:it.lancId, obraId:d.obraId, categoria:'salario', data:d.data, descricao:descFolha(f, d.ini, d.fim), forma:d.forma, unidade:r.unidade, qtd:r.qtd, vu:round2(r.vu),
          total:round2(r.qtd*round2(r.vu)), subcat:'', tipo:'', venc:pend?d.venc:'', status:pend?'Pendente':'Pago', fornecedor:f.nome, doc:'', etapa:'', mesRef:mesRefDe(d.data), obs:r.obs,
          comprovanteId:'', criadoPor:S.usuario.id, criadoEm:new Date(op.criadoEm).toISOString(), alteradoPor:'', alteradoEm:'', cancelado:false, motivoCancel:'', _pend:true});
        dias.forEach(p=>{ p.lancId = it.lancId; p._pend = true; });
      }
      break; }
    default: break;
  }
}

async function enfileirar(tipo, dados){
  const op = {opId:uid(), tipo, dados, criadoEm:Date.now(), usuario:SESSAO.usuario.id};
  FILA.push(op);
  await kv.set('fila', FILA);
  aplicarLocal(op);
  return op;
}

function montarLote(fila){
  const lote = []; let tam = 0;
  for (const op of fila){
    const t = JSON.stringify(op).length;
    if (lote.length && (tam + t > 12e6 || lote.length >= 100)) break;
    lote.push(op); tam += t;
  }
  return lote;
}

async function sincronizar(manual){
  if (sincronizando || !SESSAO || !CONF.api) return;
  if (!navigator.onLine && !manual){ statusSync(); return; }
  sincronizando = true; statusSync();
  try {
    const lote = montarLote(FILA);
    const r = await api('sync', {ops: lote});
    const resp = new Map((r.resultados||[]).map(x=>[x.opId, x]));
    const recusadas = lote.filter(op=>resp.has(op.opId) && !resp.get(op.opId).ok);
    if (recusadas.length){
      for (const op of recusadas) REJ.unshift({quando:new Date().toISOString(), resumo:resumoOp(op), erro:resp.get(op.opId).erro});
      REJ = REJ.slice(0,50); await kv.set('rejeitados', REJ);
      toast(`${recusadas.length} operação(ões) recusada(s) pelo servidor — veja o aviso no Início.`);
    }
    FILA = FILA.filter(op=>!resp.has(op.opId));
    await kv.set('fila', FILA);
    BASE = {api:r.api||1, usuario:r.usuario, cfg:r.cfg, obras:r.obras, lanc:r.lanc, periodos:r.periodos, func:r.func||[], presencas:r.presencas||[], nomes:r.nomes||{}};
    SESSAO.usuario = r.usuario; await kv.set('sessao', SESSAO);
    await kv.set('cache', BASE);
    ultimoErroSync = ''; ultimoSyncOk = Date.now();
    reconstruir();
    sincronizando = false;
    rotear(true);
    if (FILA.length) setTimeout(()=>sincronizar(), 200);
  } catch(e){
    sincronizando = false;
    if (e.codigo==='SESSAO'){ ultimoErroSync = e.message; await expirarSessao(e.message); return; }
    if (e.codigo==='TROCAR_SENHA'){ mostrarLogin('troca'); return; }
    ultimoErroSync = e instanceof ErroRede ? '' : e.message;
    if (manual) toast(e instanceof ErroRede ? 'Sem conexão. Os lançamentos ficam guardados no aparelho.' : e.message);
  } finally { sincronizando = false; statusSync(); }
}

function resumoOp(op){
  const d = op.dados||{};
  const nomes = {'obra.salvar':'Obra', 'obra.arquivar':'Arquivar obra', 'lanc.salvar':'Lançamento', 'lanc.cancelar':'Cancelamento', 'lanc.pagar':'Pagamento',
    'periodo.salvar':'Período', 'periodo.excluir':'Excluir período', 'comprovante.enviar':'Comprovante', 'relatorio.salvar':'Relatório no Drive',
    'func.salvar':'Funcionário', 'presenca.salvar':'Chamada de '+fmtData(d.data), 'folha.gerar':'Pagamento de diárias'};
  const l = S && S.lanc.find(x=>x.id===(d.id||d.lancId));
  const desc = d.descricao || d.nome || (l && l.descricao) || '';
  const val = d.qtd && d.vu ? ' — ' + fmtBRL(d.qtd*d.vu) : '';
  return `${nomes[op.tipo]||op.tipo}: ${desc}${val}`;
}

function statusSync(){
  let txt, tit;
  const n = FILA.length;
  if (sincronizando){ txt = '↻ Sincronizando…'; tit = 'Enviando ao Drive'; }
  else if (!navigator.onLine){ txt = n ? `📴 Offline · ${n} pendente(s)` : '📴 Offline'; tit = 'Sem internet. Tudo continua funcionando e será enviado depois.'; }
  else if (ultimoErroSync){ txt = '⚠ Erro ao sincronizar'; tit = ultimoErroSync; }
  else if (n){ txt = `⏳ ${n} pendente(s)`; tit = 'Toque para enviar agora'; }
  else { txt = '✓ Sincronizado'; tit = ultimoSyncOk ? 'Última sincronização: ' + new Date(ultimoSyncOk).toLocaleTimeString('pt-BR') : ''; }
  document.querySelectorAll('.sync').forEach(b=>{ b.textContent = txt; b.title = tit; });
}

async function expirarSessao(msg){
  SESSAO.token = null; await kv.set('sessao', SESSAO);
  mostrarLogin('login', msg + (FILA.length ? ` Há ${FILA.length} operação(ões) guardada(s) que serão enviadas após entrar.` : ''));
}

/* =====================================================================
   INTERFACE — utilitários
   ===================================================================== */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let editingId = null, listaCat = 'todas', sortK = 'data', sortD = -1, pagandoId = null, cancelandoId = null, compArquivo = null, usuarioEditando = null;
const charts = {};
const nomeUsuario = id => (S && S.nomes && S.nomes[id]) || (S && S.usuario && id===S.usuario.id ? S.usuario.nome : '');

function toast(msg){ const t=$('toast'); t.textContent=msg; t.classList.add('on'); clearTimeout(toast._t); toast._t=setTimeout(()=>t.classList.remove('on'),3200); }
function fillSelect(el, arr, vazio){
  const v = el.value;
  el.innerHTML = (vazio!==undefined ? `<option value="">${esc(vazio)}</option>` : '') + arr.map(x=>`<option>${esc(x)}</option>`).join('');
  if ([...el.options].some(o=>o.value===v)) el.value = v;
}
const badge = k => `<span class="badge" style="--c:${CATS[k].cor}">${esc(CATS[k].nome)}</span>`;
const chipSit = sit => `<span class="sit sit-${sit}">${SITUACAO[sit]}</span>`;

/* ---------- permissões (espelham o servidor) ---------- */
const perfil = () => S.usuario.perfil;
const ehAdmin = () => perfil()==='admin';
const ehProp = () => perfil()==='proprietario';
const catsPermitidas = () => ehProp() ? CAT_PROPRIETARIO : CAT_ORDER;
const podePagar = l => ehPendente(l) && !(ehProp() && l.categoria==='dia');
const podeEditar = l => !l.cancelado && (ehAdmin() || l.criadoPor===S.usuario.id);

/* ---------- tema ---------- */
function aplicarTema(){
  const t = PREFS.tema||'escuro', r = document.documentElement;
  r.dataset.theme = t==='claro' ? 'light' : t==='auto' ? 'auto' : 'dark';
  const mt = document.querySelector('meta[name=theme-color]'); if (mt) mt.content = getComputedStyle(r).getPropertyValue('--bg').trim() || '#0b0d22';
  document.querySelectorAll('.btnTema').forEach(b=>b.textContent = t==='claro' ? '☀️ Claro' : t==='escuro' ? '🌙 Escuro' : '🖥️ Auto');
  document.querySelectorAll('.btnTema').forEach(b=>b.title='Tema: toque para alternar entre claro, escuro e automático');
}
function alternarTema(){
  const ord = ['claro','escuro','auto'];
  PREFS.tema = ord[(ord.indexOf(PREFS.tema||'escuro')+1)%3]; salvarPrefs(); aplicarTema();
  if (S && obraAtualId()) renderResumo();
}

/* ---------- navegação ---------- */
function mostrarView(v){ ['login','home','obra','admin'].forEach(x=>$('view-'+x).hidden = x!==v); }
function obraAtualId(){ const m = location.hash.match(/^#\/obra\/([\w-]+)/); return m && S && S.obras.some(o=>o.id===m[1]) ? m[1] : null; }
const obraAtual = () => S.obras.find(o=>o.id===obraAtualId());
const lancObra = () => S.lanc.filter(l=>l.obraId===obraAtualId());
const ativos = () => lancObra().filter(l=>!l.cancelado);
const perObra = () => S.periodos.filter(p=>p.obraId===obraAtualId()).sort((a,b)=>a.ini.localeCompare(b.ini));
const irObra = id => { location.hash = '#/obra/'+id; };
const irInicio = () => { location.hash = '#/'; };
let viewAnterior = null, obraAnterior = null;

function rotear(soAtualizar){
  if (!SESSAO || !SESSAO.token || !S){ return; }
  const h = location.hash;
  if (h.startsWith('#/obra/') && !obraAtualId()){ history.replaceState(null,'','#/'); }
  const id = obraAtualId();
  if (h==='#/admin' && ehAdmin()){
    mostrarView('admin');
    if (viewAnterior!=='admin'){ abrirAbaAdmin(abaAdmin); carregarObrasAdmin(); carregarUsuarios(); }
    viewAnterior = 'admin'; return;
  }
  if (h==='#/admin') history.replaceState(null,'','#/');
  if (id){
    mostrarView('obra');
    if (!soAtualizar || obraAnterior!==id){
      listaCat='todas'; ['r-ini','r-fim','l-ini','l-fim','l-txt','l-sit','l-etapa'].forEach(x=>$(x).value=''); $('histBody').innerHTML='';
      chamada = {data:hojeIso(), marcas:{}}; folhaSel = {}; funcEditando = null; ['fo-ini','fo-fim','fo-data','mp-mes'].forEach(x=>$(x).value='');
      renderListas(); limparForm(false); abrirTab('lancar'); window.scrollTo(0,0); preencherDadosObra(); limparFunc();
    }
    obraAnterior = id; viewAnterior = 'obra';
    document.title = `${obraAtual().nome} — Controle de Obras`;
    renderObra();
  } else {
    mostrarView('home'); obraAnterior = null;
    if (viewAnterior!=='home') window.scrollTo(0,0);
    viewAnterior = 'home'; document.title = 'Controle de Obras';
    renderHome();
  }
  statusSync();
  if (!soAtualizar) sincronizar();       // ao abrir uma tela, busca o que outros usuários lançaram
}

/* =====================================================================
   LOGIN
   ===================================================================== */
function mostrarLogin(etapa, aviso){
  mostrarView('login'); viewAnterior = 'login';
  $('boxServidor').hidden = etapa!=='servidor'; $('boxLogin').hidden = etapa!=='login'; $('boxTroca').hidden = etapa!=='troca';
  if (etapa==='servidor'){ $('s-url').value = CONF.api||''; $('s-erro').textContent=''; }
  if (etapa==='login'){ $('lg-erro').textContent=''; $('lg-pass').value=''; $('lg-aviso').textContent = aviso||''; if (SESSAO && SESSAO.usuario) $('lg-user').value = SESSAO.usuario.login; }
  if (etapa==='troca'){ ['tr-atual','tr-nova','tr-conf'].forEach(i=>$(i).value=''); $('tr-erro').textContent=''; }
}
async function conectarServidor(){
  const url = $('s-url').value.trim();
  if (!/^https:\/\/script\.google(usercontent)?\.com\/.+/.test(url) && !/^http:\/\/localhost(:\d+)?\//.test(url)){
    $('s-erro').textContent = 'Endereço inválido. Deve começar com https://script.google.com/'; return; }
  $('s-ok').disabled = true; $('s-erro').textContent = 'Testando conexão…';
  const antigo = CONF.api; CONF.api = url;
  try {
    const r = await api('ping', {}, true);
    if (!r.instalado){ $('s-erro').textContent = 'Servidor encontrado, mas ainda não instalado (rode instalar() no Apps Script).'; CONF.api = antigo; return; }
    await kv.set('conf', CONF); mostrarLogin('login');
  } catch(e){ CONF.api = antigo; $('s-erro').textContent = e.message; }
  finally { $('s-ok').disabled = false; }
}
async function entrar(){
  const login = $('lg-user').value.trim(), senha = $('lg-pass').value;
  if (!login || !senha){ $('lg-erro').textContent = 'Informe usuário e senha.'; return; }
  $('lg-ok').disabled = true; $('lg-erro').textContent = 'Entrando…';
  try {
    const r = await api('login', {login, senha}, true);
    if (FILA.length && FILA[0].usuario !== r.usuario.id){
      if (!confirm(`Existem ${FILA.length} operação(ões) não enviadas de outro usuário neste aparelho. Entrar descarta essas operações. Continuar?`)){ $('lg-erro').textContent=''; return; }
      FILA = []; await kv.set('fila', FILA); BASE = null; await kv.del('cache');
    }
    if (SESSAO && SESSAO.usuario && SESSAO.usuario.id !== r.usuario.id){ BASE = null; await kv.del('cache'); }
    SESSAO = {token:r.token, usuario:r.usuario}; await kv.set('sessao', SESSAO);
    $('lg-pass').value = ''; $('lg-erro').textContent = '';
    if (r.usuario.trocarSenha){ mostrarLogin('troca'); return; }
    await iniciarSessao();
  } catch(e){ $('lg-erro').textContent = e instanceof ErroRede ? 'Sem conexão. O primeiro acesso precisa de internet.' : e.message; }
  finally { $('lg-ok').disabled = false; }
}
function validarSenhaNova(nova, conf){
  if (nova.length < 8) return 'A nova senha deve ter pelo menos 8 caracteres.';
  if (!/[A-Za-z]/.test(nova) || !/\d/.test(nova)) return 'Use letras e números na nova senha.';
  if (nova !== conf) return 'A confirmação não confere.';
  return '';
}
async function trocarSenha(atual, nova, conf, elErro){
  const msg = validarSenhaNova(nova, conf); if (msg){ elErro.textContent = msg; return false; }
  elErro.textContent = 'Salvando…';
  try {
    const r = await api('trocarSenha', {atual, nova});
    SESSAO = {token:r.token, usuario:r.usuario}; await kv.set('sessao', SESSAO);
    elErro.textContent = ''; toast('Senha alterada. Outras sessões foram encerradas.'); return true;
  } catch(e){ elErro.textContent = e instanceof ErroRede ? 'Sem conexão. Trocar a senha requer internet.' : e.message; return false; }
}
async function sair(){
  if (FILA.length && !confirm(`Atenção: ${FILA.length} operação(ões) ainda não foram enviadas ao Drive e serão PERDIDAS se você sair agora.\n\nConecte-se à internet e aguarde "✓ Sincronizado" antes de sair.\n\nSair mesmo assim?`)) return;
  FILA = []; BASE = null; S = null; SESSAO = null;
  await kv.set('fila', []); await kv.del('cache'); await kv.del('sessao');
  history.replaceState(null,'','#/'); mostrarLogin('login');
}
async function iniciarSessao(){
  REJ = (await kv.get('rejeitados')) || [];
  BASE = (await kv.get('cache')) || null;
  reconstruir();
  history.replaceState(null,'', location.hash || '#/');
  viewAnterior = null;
  if (BASE) rotear(); else { mostrarView('home'); $('obrasGrid').innerHTML = '<div class="vazio">Carregando dados do servidor…</div>'; }
  await sincronizar(true);
  if (!BASE && !navigator.onLine) $('obrasGrid').innerHTML = '<div class="vazio">Sem internet. Conecte-se uma vez para baixar os dados.</div>';
}

/* =====================================================================
   INÍCIO
   ===================================================================== */
function renderHome(){
  $('homeUser').textContent = `${S.usuario.nome} · ${PERFIL_NOME[perfil()]}`;
  $('contaInfo').textContent = `Usuário: ${S.usuario.login} · Perfil: ${PERFIL_NOME[perfil()]}`;
  $('cardCadastro').hidden = ehProp();
  $('cardAdmin').hidden = !ehAdmin();
  const obras = S.obras.slice().sort((a,b)=>a.nome.localeCompare(b.nome,'pt-BR'));
  $('obrasGrid').className = obras.length ? 'obras-grid' : '';
  $('obrasGrid').innerHTML = obras.length ? obras.map(o=>{
    const L = S.lanc.filter(l=>l.obraId===o.id && !l.cancelado), t = totais(L), ult = L.reduce((m,l)=>l.data>m?l.data:m,'');
    const pend = L.filter(ehPendente), eq = equipeTotais(o.id), an = analise(o, t, eq), crit = an.alertas.filter(x=>x.nivel==='crit');
    const sub = [o.cidade, o.prop && 'Prop.: '+o.prop, o.ini && 'Início: '+fmtData(o.ini)].filter(Boolean).map(esc).join(' · ');
    return `<div class="obra-card">
      <div><h3>${esc(o.nome)} ${o._pend?'<span class="tag">⏳ não enviada</span>':''}</h3><div class="muted">${sub || 'Sem dados complementares'}</div></div>
      <div class="oc-nums">
        <div><span>Pago pelo cliente</span><b>${fmtBRL(t.cliente)}</b></div>
        <div><span>Custo total</span><b>${fmtBRL(t.custoTotal)}</b></div>
        <div class="oc-res oc-${t.situacao}"><span>Lucro esperado</span><b>${fmtBRL(t.lucro)}</b>${chipSit(t.situacao)}</div>
        <div><span>Lançamentos · último</span><b>${L.length} · ${ult ? fmtData(ult).slice(0,5) : '—'}</b></div>
      </div>
      ${crit.length ? `<div class="alerta alerta-crit">⚠ ${esc(crit[0].texto)}</div>` : ''}
      ${pend.length ? `<div class="aviso">⏰ ${pend.length} pagamento(s) pendente(s): ${fmtBRL(t.pend)}${t.proxVenc?` · próximo ${fmtData(t.proxVenc).slice(0,5)}`:''}</div>` : ''}
      ${eq.aPagar ? `<div class="aviso info">👷 Diárias da equipe a pagar: ${fmtBRL(eq.aPagar)} (${fmtNum(eq.diasAPagar)} dia(s))</div>` : ''}
      <div class="row"><button class="btn pri" data-open="${o.id}" type="button">Abrir obra →</button>
        <a class="btn" href="#/obra/${o.id}" target="_blank" rel="noopener" title="Abrir em outra aba">↗ Nova aba</a></div></div>`;
  }).join('') : `<div class="vazio"><b>Nenhuma obra disponível.</b><br>${ehProp() ? 'Peça ao administrador para liberar o acesso à sua obra.' : 'Cadastre a primeira obra abaixo.'}</div>`;
  $('boxRejeitados').hidden = !REJ.length;
  if (REJ.length) $('boxRejeitados').innerHTML = `<h2>⚠ ${REJ.length} operação(ões) recusada(s) pelo servidor</h2>
    <p class="muted">Estas operações não foram gravadas no Drive. Confira e lance novamente se necessário.</p>
    <div class="tbl-wrap"><table><tbody>${REJ.map(r=>`<tr><td>${fmtDataHora(r.quando)}</td><td class="wrap">${esc(r.resumo)}</td><td class="wrap venc-atraso">${esc(r.erro)}</td></tr>`).join('')}</tbody></table></div>
    <div class="row" style="margin-top:10px"><button class="btn" id="btnLimparRej" type="button">Limpar aviso</button></div>`;
}
function preencherListas(){
  $('c-formas').value=S.cfg.formas.join('\n'); $('c-un').value=S.cfg.unidades.join('\n'); $('c-sub').value=S.cfg.subcats.join('\n'); $('c-etapas').value=S.cfg.etapas.join('\n');
}
async function cadastrarObra(abrir){
  const nome = $('n-nome').value.trim();
  if (!nome){ $('n-erro').textContent='Informe o nome da obra.'; $('n-nome').focus(); return; }
  if (S.obras.some(o=>o.nome.toLowerCase()===nome.toLowerCase()) && !confirm(`Já existe uma obra chamada "${nome}". Cadastrar mesmo assim?`)) return;
  const id = uid();
  await enfileirar('obra.salvar', {id, nome, cidade:$('n-cidade').value.trim(), prop:$('n-prop').value.trim(), eng:$('n-eng').value.trim(), ini:$('n-ini').value});
  ['n-nome','n-cidade','n-prop','n-eng','n-ini'].forEach(i=>$(i).value=''); $('n-erro').textContent='';
  toast(`Obra "${nome}" cadastrada`);
  sincronizar();
  if (abrir) irObra(id); else renderHome();
}

/* =====================================================================
   OBRA
   ===================================================================== */
function renderObra(){
  const o = obraAtual(); if (!o) return;
  $('obraTitulo').textContent = o.nome;
  $('obraSub').textContent = [o.cidade, o.prop && 'Prop.: '+o.prop, `${S.usuario.nome} (${PERFIL_NOME[perfil()]})`].filter(Boolean).join(' · ');
  renderListas(); renderMini(); renderResumo(); renderLista(); renderDadosObra(); renderEquipe();
}
function renderListas(){
  const catAtual = $('f-cat').value || (ehProp() ? 'enviado' : 'dia');
  $('f-cat').innerHTML = catsPermitidas().map(k=>`<option value="${k}">${CATS[k].nome}</option>`).join('');
  $('f-cat').value = catsPermitidas().includes(catAtual) ? catAtual : catsPermitidas()[0];
  const unAtual = $('f-un').value;
  $('f-un').innerHTML = S.cfg.unidades.map(u=>`<option value="${esc(u)}">${esc(u)}${UN_DESC[u]?' — '+esc(UN_DESC[u]):''}</option>`).join('') + '<option value="__outra">Outra (digitar)…</option>';
  if (unAtual) $('f-un').value = unAtual;
  fillSelect($('f-forma'), S.cfg.formas); fillSelect($('f-subcat'), S.cfg.subcats, 'Selecione...');
  fillSelect($('pg-sub'), S.cfg.subcats, 'Selecione...'); fillSelect($('pg-forma'), S.cfg.formas.filter(f=>f!==FORMA_PEND));
  fillSelect($('l-sub'), S.cfg.subcats, 'Todas'); fillSelect($('l-forma'), S.cfg.formas, 'Todas');
  $('pg-cat').innerHTML = (ehProp() ? ['mo','material'] : ['mo','material','dia']).map(k=>`<option value="${k}">${CATS[k].nome}</option>`).join('');
  $('dl-etapa').innerHTML = S.cfg.etapas.map(u=>`<option value="${esc(u)}">`).join('');
  $('dl-forn').innerHTML = [...new Set(lancObra().map(l=>l.fornecedor).filter(Boolean))].sort().map(u=>`<option value="${esc(u)}">`).join('');
  $('dl-desc').innerHTML = [...new Set(ativos().slice().sort(porData).reverse().map(l=>l.descricao))].slice(0,300).map(u=>`<option value="${esc(u)}">`).join('');
  fillSelect($('l-etapa'), [...new Set([...S.cfg.etapas, ...lancObra().map(l=>l.etapa).filter(Boolean)])], 'Todas');
  $('f-catPick').innerHTML = catsPermitidas().map(k=>`<button type="button" class="pick" data-pick="${k}" style="--c:${CATS[k].cor}" aria-pressed="false">${esc(CATS[k].nome)}</button>`).join('');
  updateFormVisibility();
}

/* ---------- formulário ---------- */
const PLACEHOLDER = {cliente:'Ex.: Sinal do contrato, Medição 02, Parcela 3/6', enviado:'Ex.: Pix para custos da semana', mo:'Ex.: Quinzena pedreiros, Diária servente',
  material:'Ex.: Cimento CP II 50 kg, Milheiro de tijolo', dia:'Ex.: Abastecimento, Almoço da equipe, Uber', salario:'Ex.: Salário de outubro', apagar:'Ex.: Aluguel de escavadeira, Medição do empreiteiro'};
function updateFormVisibility(){
  const cat = $('f-cat').value, recebimento = cat==='enviado' || cat==='cliente';
  document.querySelectorAll('#tab-lancar [data-show]').forEach(el=>{ el.hidden = !el.dataset.show.split(',').includes(cat); });
  document.querySelectorAll('#f-catPick .pick').forEach(b=>{ const on = b.dataset.pick===cat; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
  if (TIPOS[cat]){
    const atual = $('f-tipo').value;
    if ($('f-tipo').dataset.cat !== cat){ $('f-tipo').innerHTML = TIPOS[cat].map(x=>`<option>${esc(x)}</option>`).join(''); $('f-tipo').dataset.cat = cat; }
    if (TIPOS[cat].includes(atual)) $('f-tipo').value = atual;
    $('lbl-tipo').textContent = cat==='cliente' ? 'Tipo do recebimento' : 'Tipo do envio';
  }
  $('f-desc').placeholder = PLACEHOLDER[cat] || '';
  const optPend = [...$('f-forma').options].find(o=>o.value===FORMA_PEND);
  if (optPend){ optPend.disabled = optPend.hidden = recebimento; if (recebimento && $('f-forma').value===FORMA_PEND) $('f-forma').value = S.cfg.formas[0]; }
  const aPrazo = $('f-forma').value===FORMA_PEND && cat!=='apagar';
  $('f-venc').closest('.fld').hidden = !(cat==='apagar' || aPrazo);
  document.querySelector('label[for=f-venc]').textContent = aPrazo ? 'Data prevista de pagamento' : 'Vencimento';
  $('lbl-forn').textContent = cat==='enviado' ? 'Origem do recurso (quem enviou)' : cat==='cliente' ? 'Pagador (cliente)' : cat==='mo' ? 'Beneficiário' : cat==='salario' ? 'Origem' : 'Fornecedor / Beneficiário';
  $('lbl-doc').textContent = cat==='cliente' ? 'Nº NF / Recibo / Medição' : 'Nº NF / Recibo / Documento';
  $('f-un-outra').hidden = $('f-un').value !== '__outra';
}
const getUnidade = () => $('f-un').value==='__outra' ? $('f-un-outra').value.trim() : $('f-un').value;
function setUnidade(u){
  if (S.cfg.unidades.includes(u)){ $('f-un').value=u; $('f-un-outra').value=''; } else { $('f-un').value='__outra'; $('f-un-outra').value=u||''; }
  updateFormVisibility();
}
function calcTotal(){ const q = parseNum($('f-qtd').value), v = parseNum($('f-vu').value); $('f-total').value = (isFinite(q) && isFinite(v)) ? fmtBRL(round2(q*round2(v))) : ''; }
function limparComp(){ compArquivo = null; $('f-comp').value=''; $('f-compPrev').hidden = true; }
function limparForm(manter){
  const keep = manter ? {data:$('f-data').value, forma:$('f-forma').value, cat:$('f-cat').value, sub:$('f-subcat').value, un:getUnidade(), etapa:$('f-etapa').value, mes:$('f-mes').value} : null;
  ['f-desc','f-vu','f-total','f-forn','f-doc','f-obs','f-venc','f-etapa','f-mes'].forEach(id=>$(id).value='');
  $('f-qtd').value = '1'; $('f-tipo').selectedIndex = 0; limparComp();
  $('f-data').value = hojeIso(); $('f-cat').value = ehProp() ? 'enviado' : 'dia'; $('f-subcat').value = ''; $('f-forma').value = S.cfg.formas[0]||'';
  setUnidade('vb');
  if (keep){ $('f-data').value=keep.data; $('f-forma').value=keep.forma; $('f-cat').value=keep.cat; $('f-subcat').value=keep.sub; setUnidade(keep.un); $('f-etapa').value=keep.etapa; $('f-mes').value=keep.mes; }
  $('f-mes').value = $('f-mes').value || mesRefDe($('f-data').value);
  editingId = null; $('formTitulo').textContent='Novo lançamento'; $('btnCancelar').hidden=true; $('btnSalvar').textContent='Salvar';
  $('f-erro').textContent = ''; $('f-dica').hidden = true; updateFormVisibility();
}
function preencherForm(l){
  $('f-desc').value=l.descricao; $('f-data').value=l.data;
  $('f-cat').value = catsPermitidas().includes(l.categoria) ? l.categoria : catsPermitidas()[0]; $('f-forma').value=l.forma;
  updateFormVisibility(); $('f-subcat').value=l.subcat||''; if (TIPOS[l.categoria]) $('f-tipo').value = l.tipo || TIPOS[l.categoria][0]; $('f-venc').value=l.venc||'';
  $('f-qtd').value=String(l.qtd).replace('.',','); $('f-vu').value=String(l.vu).replace('.',',');
  $('f-forn').value=l.fornecedor||''; $('f-doc').value=l.doc||''; $('f-etapa').value=l.etapa||''; $('f-mes').value=l.mesRef||''; $('f-obs').value=l.obs||'';
  setUnidade(l.unidade); calcTotal(); limparComp();
}
function coletarForm(){
  const cat = $('f-cat').value, q = parseNum($('f-qtd').value), v = parseNum($('f-vu').value), un = getUnidade();
  const erros = [];
  if (!$('f-desc').value.trim()) erros.push('descrição');
  if (!$('f-data').value) erros.push('data');
  if (!$('f-forma').value) erros.push('forma de pagamento');
  if (!un) erros.push('unidade');
  if (!(q>0)) erros.push('quantitativo (maior que zero)');
  if (!(v>0)) erros.push('valor unitário (maior que zero)');
  if (cat==='dia' && !$('f-subcat').value) erros.push('subcategoria');
  const pendente = cat==='apagar' || $('f-forma').value===FORMA_PEND;
  if (pendente && !$('f-venc').value) erros.push(cat==='apagar' ? 'vencimento' : 'data prevista de pagamento');
  if (erros.length){ $('f-erro').textContent = 'Preencha: ' + erros.join(', ') + '.'; return null; }
  $('f-erro').textContent = '';
  const data = $('f-data').value;
  return { obraId:obraAtualId(), descricao:$('f-desc').value.trim(), data, forma:$('f-forma').value, categoria:cat, unidade:un, qtd:q, vu:round2(v),
    subcat: cat==='dia' ? $('f-subcat').value : '', tipo: TIPOS[cat] ? $('f-tipo').value : '', venc: pendente ? $('f-venc').value : '',
    fornecedor:$('f-forn').value.trim(), doc:$('f-doc').value.trim(), etapa:$('f-etapa').value.trim(), mesRef:$('f-mes').value || mesRefDe(data), obs:$('f-obs').value.trim() };
}
function possivelDuplicado(o, id){
  const n = s => (s||'').trim().toLowerCase(), tot = round2(o.qtd*o.vu);
  return ativos().find(l => l.id!==id && l.data===o.data && l.categoria===o.categoria && round2(l.total)===tot &&
    (n(l.descricao)===n(o.descricao) || (o.fornecedor && n(l.fornecedor)===n(o.fornecedor))));
}
async function salvar(continuar){
  const o = coletarForm(); if (!o) return;
  if (o.categoria==='cliente' && BASE && (BASE.api||1) < 3){ $('f-erro').textContent = 'O servidor ainda não aceita "Valor pago pelo cliente". O administrador precisa concluir a Parte 1 da atualização (Google).'; return; }
  if (o.forma===FORMA_PEND && BASE && (BASE.api||1) < 2){ $('f-erro').textContent = 'O servidor ainda não aceita a forma "A pagar". O administrador precisa concluir a Parte 1 da atualização (Google).'; return; }
  const id = editingId || uid();
  const dup = possivelDuplicado(o, id);
  if (dup && !confirm(`Possível duplicidade:\n\n${fmtData(dup.data)} — ${dup.descricao} — ${fmtBRL(dup.total)} (${CATS[dup.categoria].nome})\n\nSalvar mesmo assim?`)) return;
  const comp = compArquivo;
  await enfileirar('lanc.salvar', {...o, id});
  if (comp) await enfileirar('comprovante.enviar', {lancId:id, mime:comp.mime, base64:comp.base64, nome:comp.nome});
  toast((editingId ? 'Lançamento atualizado' : 'Lançamento salvo — ' + fmtBRL(o.qtd*o.vu)) + (navigator.onLine ? '' : ' (será enviado quando houver internet)'));
  limparForm(continuar); renderObra();
  if (continuar) $('f-desc').focus();
  sincronizar();
}

/* ---------- preenchimento pelo histórico e comparação de preço ---------- */
function ultimoIgual(){
  const d = $('f-desc').value.trim().toLowerCase(), cat = $('f-cat').value;
  if (!d) return null;
  return ativos().filter(l=>l.id!==editingId && l.categoria===cat && l.descricao.trim().toLowerCase()===d).sort(porData).pop() || null;
}
function sugerirPorDescricao(){
  const ant = ultimoIgual();
  if (ant && !editingId){
    if (!$('f-vu').value) $('f-vu').value = String(ant.vu).replace('.',',');
    setUnidade(ant.unidade);
    if (!$('f-forn').value) $('f-forn').value = ant.fornecedor||'';
    if (ant.categoria==='dia' && !$('f-subcat').value) $('f-subcat').value = ant.subcat||'';
    if (!$('f-etapa').value) $('f-etapa').value = ant.etapa||'';
    calcTotal();
  }
  dicaPreco();
}
function dicaPreco(){
  const ant = ultimoIgual(), el = $('f-dica');
  if (!ant || !['material','mo','dia','apagar'].includes(ant.categoria)){ el.hidden = true; return; }
  const vu = parseNum($('f-vu').value);
  let txt = `Última vez: ${fmtBRL(ant.vu)} por ${ant.unidade} em ${fmtData(ant.data)}${ant.fornecedor?` (${ant.fornecedor})`:''}.`, nivel = 'info';
  if (vu > 0 && ant.vu > 0){
    const v = (vu - ant.vu) / ant.vu;
    if (Math.abs(v) >= 0.05){ txt += ` O valor informado está ${pct(Math.abs(v))} ${v>0?'acima':'abaixo'}.`; if (v >= 0.10) nivel = 'aviso'; }
    else txt += ' Mesmo preço.';
  }
  el.className = `alerta alerta-${nivel}`; el.textContent = txt; el.hidden = false;
}

/* ---------- comprovante: reduz fotos para economizar dados ---------- */
function lerArquivo(file){ return new Promise((ok, falha)=>{ const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => falha(r.error); r.readAsDataURL(file); }); }
async function prepararComprovante(file){
  if (file.type === 'application/pdf'){
    if (file.size > 8*1024*1024) throw new Error('PDF maior que 8 MB.');
    const url = await lerArquivo(file);
    return {mime:'application/pdf', base64:url.split(',')[1], nome:file.name, tamanho:file.size};
  }
  if (!file.type.startsWith('image/')) throw new Error('Use uma foto ou um PDF.');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, falha)=>{ const i = new Image(); i.onload = () => ok(i); i.onerror = () => falha(new Error('Não foi possível ler a imagem.')); i.src = url; });
    const max = 1600, esc = Math.min(1, max/Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth*esc); c.height = Math.round(img.naturalHeight*esc);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const dataUrl = c.toDataURL('image/jpeg', 0.72);
    const base64 = dataUrl.split(',')[1];
    return {mime:'image/jpeg', base64, nome:file.name.replace(/\.\w+$/,'')+'.jpg', tamanho:Math.round(base64.length*0.75), preview:dataUrl};
  } finally { URL.revokeObjectURL(url); }
}
async function aoEscolherComprovante(){
  const f = $('f-comp').files[0]; if (!f) return limparComp();
  try {
    compArquivo = await prepararComprovante(f);
    $('f-compPrev').hidden = false;
    $('f-compInfo').innerHTML = (compArquivo.preview ? `<img src="${compArquivo.preview}" alt="">` : '📄 ') + ` ${esc(compArquivo.nome)} · ${(compArquivo.tamanho/1024).toFixed(0)} KB`;
  } catch(e){ limparComp(); toast(e.message); }
}
async function verComprovante(id){
  const l = S.lanc.find(x=>x.id===id); if (!l) return;
  $('cp-visor').innerHTML = '<p class="muted">Carregando…</p>'; $('dlgComp').showModal();
  let mime, base64;
  try {
    const opPend = FILA.find(op=>op.tipo==='comprovante.enviar' && op.dados.lancId===id);
    if (opPend){ mime = opPend.dados.mime; base64 = opPend.dados.base64; }
    else { const r = await api('comprovante', {id}); mime = r.mime; base64 = r.base64; }
  } catch(e){ $('cp-visor').innerHTML = `<p class="erro">${esc(e instanceof ErroRede ? 'Sem conexão. O comprovante fica no Drive e aparece quando houver internet.' : e.message)}</p>`; return; }
  if (mime.startsWith('image/')) $('cp-visor').innerHTML = `<img src="data:${esc(mime)};base64,${base64}" alt="Comprovante">`;
  else {
    const bytes = Uint8Array.from(atob(base64), c=>c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], {type:'application/pdf'}));
    $('cp-visor').innerHTML = `<p>Comprovante em PDF.</p><a class="btn pri" href="${url}" download="comprovante-${esc(l.descricao.slice(0,30))}.pdf">Baixar PDF</a>`;
  }
}

/* ---------- mini resumo ---------- */
function kpiHTML(lbl, v, cor, sub, cls){
  return `<div class="kpi ${cls||''}" style="--c:${cor}"><div class="l">${esc(lbl)}</div><div class="v">${fmtBRL(v)}</div>${sub?`<div class="s">${esc(sub)}</div>`:''}</div>`;
}
function kpisFull(t){
  const pc = k => t.custoTotal ? ` · ${pct(t[k]/t.custoTotal)} do custo` : '';
  return CAT_CUSTO.map(k=>kpiHTML(CATS[k].nome, t[k], CATS[k].cor, `${k==='dia'&&t.diaPend?`${fmtBRL(t.diaPend)} ainda a pagar`:'custo lançado'}${pc(k)}`)).join('') +
    `<div class="kpi" style="--c:${CATS.apagar.cor}"><div class="l">Valor a pagar (lançado para pagar depois)</div><div class="v">${fmtBRL(t.prevAPagar)}</div>
      <div class="s">Já pago <b>${fmtBRL(t.pagoAPagar)}</b> · pendente <b>${fmtBRL(t.pend)}</b>${t.proxVenc?` · próximo ${fmtData(t.proxVenc)}`:''}</div>
      ${t.prevAPagar>0?`<div class="barra-mini" title="Já pago ${pct(t.pagoAPagar/t.prevAPagar)}"><i style="width:${Math.min(100,t.pagoAPagar/t.prevAPagar*100)}%"></i></div>`:''}</div>` +
    kpiHTML(CATS.enviado.nome, t.enviado, CATS.enviado.cor, t.reembRec ? `inclui ${fmtBRL(t.reembRec)} de reembolso · não é custo` : 'caixa do engenheiro · não é custo') +
    kpiHTML('Reembolso', Math.abs(t.reembolso), '#94a3b8', interpretaReemb(t.reembolso)) +
    (S.func.some(f=>f.obraId===obraAtualId()) ? (eq=>kpiHTML('Diárias da equipe a pagar', eq.aPagar, CATS.salario.cor, eq.aPagar ? `${fmtNum(eq.diasAPagar)} dia(s) trabalhados ainda sem pagamento` : 'nenhuma diária pendente'))(equipeTotais(obraAtualId())) : '');
}
function tileLucro(t, extra){
  return `<div class="kpi lucro lucro-${t.situacao} ${extra||''}"><div class="l">Lucro esperado ${chipSit(t.situacao)}</div><div class="v">${fmtBRL(t.lucro)}</div>
    <div class="s">${t.cliente>0 ? `Margem de ${pct(t.margem)} sobre o valor pago pelo cliente` : 'Lance o valor pago pelo cliente para calcular a margem'}</div></div>`;
}
function renderMini(){
  const L = ativos(), t = totais(L), pend = lancObra().filter(l=>l._pend).length, an = analise(obraAtual(), t, equipeTotais(obraAtualId()));
  const al = an.alertas.find(x=>x.nivel==='crit') || an.alertas.find(x=>x.nivel==='aviso');
  $('miniKpis').innerHTML = tileLucro(t, 'span2') +
    kpiHTML('Pago pelo cliente', t.cliente, CATS.cliente.cor, `${t.qCliente} recebimento(s)`) +
    kpiHTML('Custo total da obra', t.custoTotal, '#6366f1', `${L.length} lançamento(s)${pend?` · ${pend} a enviar`:''}`) +
    kpiHTML('Valor a pagar pendente', t.pend, CATS.apagar.cor, t.qPend ? `${t.qPend} item(ns) · próximo ${fmtData(t.proxVenc)}` : 'nada pendente') +
    kpiHTML('Reembolso', Math.abs(t.reembolso), '#94a3b8', interpretaReemb(t.reembolso)) +
    (al ? `<button class="alerta alerta-${al.nivel} span2" type="button" data-irtab="resumo">${al.nivel==='crit'?'⚠':'!'} ${esc(al.texto)} <u>Ver resumo</u></button>` : '');
  const ult = lancObra().slice().sort((a,b)=>String(b.criadoEm||'').localeCompare(String(a.criadoEm||''))).slice(0,6);
  $('ultimos').innerHTML = ult.length ? ult.map(l=>`<tr class="${l.cancelado?'cancel':''}"><td title="${fmtData(l.data)}">${fmtData(l.data).slice(0,5)}</td><td>${badge(l.categoria)}</td><td>${esc(l.descricao)} ${l._pend?'<span class="tag">⏳</span>':''}</td><td class="n">${fmtBRL(l.total)}</td>
    <td>${podeEditar(l)?`<button class="btn sm" data-act="edit" data-id="${l.id}" type="button" title="Editar" aria-label="Editar">✎</button>`:''}</td></tr>`).join('')
    : `<tr><td class="muted">Nenhum lançamento nesta obra ainda.</td></tr>`;
}

/* ---------- resumo ---------- */
function barra(frac, nivel){ const w = Math.max(0, Math.min(1, frac||0))*100; return `<div class="barra-h ${nivel?'b-'+nivel:''}"><i style="width:${w}%"></i></div>`; }
const nivelPct = x => x==null ? '' : x > 1 ? 'crit' : x >= 0.9 ? 'aviso' : 'ok';
function renderResumo(){
  if (!obraAtualId()) return;
  const ini=$('r-ini').value, fim=$('r-fim').value, filtrado = !!(ini||fim);
  const obra = obraAtual(), todos = ativos();
  const L = todos.filter(l => (!ini || l.data>=ini) && (!fim || l.data<=fim)), t = totais(L);
  const tObra = filtrado ? totais(todos) : t, an = analise(obra, tObra, equipeTotais(obra.id));
  $('r-nota').textContent = filtrado ? 'Valores do período escolhido. Contrato, orçamento, prazo e alertas consideram a obra inteira.' : '';
  // alertas
  $('alertas').innerHTML = an.alertas.map(x=>`<div class="alerta alerta-${x.nivel}" role="${x.nivel==='crit'?'alert':'status'}">${{crit:'⚠',aviso:'!',info:'i',ok:'✓'}[x.nivel]} ${esc(x.texto)}</div>`).join('');
  // painel de resultado
  $('painelRes').innerHTML =
    kpiHTML('Valor pago pelo cliente', t.cliente, CATS.cliente.cor, an.contrato>0 && !filtrado ? `${pct(an.pctRecebido)} do contrato de ${fmtBRL(an.contrato)}` : `${t.qCliente} recebimento(s)`) +
    kpiHTML('Custo total da obra', t.custoTotal, '#6366f1', `${fmtBRL(t.custoLancado)} lançados + ${fmtBRL(t.apagar)} a pagar sem categoria`) +
    tileLucro(t) +
    `<div class="kpi" style="--c:#64748b"><div class="l">Resultado atual</div><div class="v ${t.resultadoAtual<-0.004?'neg':''}">${fmtBRL(t.resultadoAtual)}</div>
      <div class="s">Pago pelo cliente − custos lançados (sem os valores a pagar)</div></div>`;
  // demonstrativo
  const linhaD = (sinal, rot, v, cls, extra) => `<tr class="${cls||''}"><td class="sinal">${sinal}</td><td>${rot}</td><td class="n">${fmtBRL(v)}</td><td class="n muted">${extra??''}</td></tr>`;
  const pc = v => t.custoTotal ? pct(v/t.custoTotal) : '';
  $('dre').innerHTML =
    linhaD('+', 'Valor pago pelo cliente', t.cliente, 'dre-receita') +
    CAT_CUSTO.map(k=>linhaD('−', CATS[k].nome, t[k], '', pc(t[k]))).join('') +
    linhaD('=', '<b>Resultado atual</b>', t.resultadoAtual, 'dre-sub') +
    linhaD('−', 'Valor a pagar ainda sem categoria', t.apagar, '', pc(t.apagar)) +
    `<tr class="dre-final dre-${t.situacao}"><td class="sinal">=</td><td><b>Lucro esperado</b> ${chipSit(t.situacao)}</td><td class="n"><b>${fmtBRL(t.lucro)}</b></td><td class="n">${t.cliente>0?pct(t.margem):''}</td></tr>` +
    `<tr class="dre-nota"><td></td><td colspan="3">Custo total da obra: <b>${fmtBRL(t.custoTotal)}</b>. Margem = lucro esperado ÷ valor pago pelo cliente.</td></tr>`;
  // contrato, orçamento e prazo
  let h = '';
  if (an.contrato > 0){
    h += `<div class="bloco"><h3>Contrato</h3>
      <div class="lin"><span>Valor do contrato</span><b>${fmtBRL(an.contrato)}</b></div>
      <div class="lin"><span>Pago pelo cliente</span><b>${fmtBRL(tObra.cliente)} <small>(${pct(an.pctRecebido)})</small></b></div>${barra(an.pctRecebido,'ok')}
      <div class="lin"><span>Falta receber</span><b>${fmtBRL(an.aReceber)}</b></div>
      ${an.margemPrevista!=null?`<div class="lin"><span>Margem prevista (contrato − orçamento)</span><b class="${an.margemPrevista<0?'neg':''}">${fmtBRL(an.margemPrevista)} <small>(${pct(an.margemPrevista/an.contrato)})</small></b></div>`:''}
      <div class="lin"><span title="Contrato − o maior valor entre o orçamento e o custo total atual">Margem projetada</span><b class="${an.margemProjetada<0?'neg':''}">${fmtBRL(an.margemProjetada)} <small>(${pct(an.margemProjetada/an.contrato)})</small></b></div></div>`;
  }
  if (an.temOrc){
    h += `<div class="bloco"><h3>Orçamento × realizado</h3>` + an.porCat.map(c=>`
      <div class="lin"><span>${CATS[c.k].nome}</span><b>${fmtBRL(c.real)} <small>de ${fmtBRL(c.prev)} · ${pct(c.pct)}</small></b></div>${barra(c.pct, nivelPct(c.pct))}`).join('') +
      `<div class="lin tot"><span>Custo total × orçamento</span><b>${fmtBRL(tObra.custoTotal)} <small>de ${fmtBRL(an.orcTotal)} · ${pct(an.pctOrc)}</small></b></div>${barra(an.pctOrc, nivelPct(an.pctOrc))}
      <div class="lin"><span>Saldo do orçamento</span><b class="${an.saldoOrc<0?'neg':''}">${fmtBRL(an.saldoOrc)}</b></div></div>`;
  }
  if (an.pctPrazo!=null){
    h += `<div class="bloco"><h3>Prazo</h3>
      <div class="lin"><span>${fmtData(obra.ini)} → ${fmtData(obra.fim)}</span><b>${an.diasRestantes>=0?`faltam ${an.diasRestantes} dia(s)`:`encerrado há ${-an.diasRestantes} dia(s)`}</b></div>
      <div class="lin"><span>Prazo decorrido</span><b>${pct(an.pctPrazo)}</b></div>${barra(an.pctPrazo)}
      ${an.temOrc?`<div class="lin"><span>Orçamento consumido</span><b>${pct(an.pctOrc)}</b></div>${barra(an.pctOrc, an.pctOrc-an.pctPrazo>0.15?'aviso':'ok')}`:''}</div>`;
  }
  if (an.area > 0){
    h += `<div class="bloco"><h3>Por m² <small>(${fmtNum(an.area)} m²)</small></h3>
      <div class="lin"><span>Custo total por m²</span><b>${fmtBRL(an.custoM2)}</b></div>
      ${an.orcM2?`<div class="lin"><span>Orçamento por m²</span><b>${fmtBRL(an.orcM2)}</b></div>`:''}
      ${an.contratoM2?`<div class="lin"><span>Contrato por m²</span><b>${fmtBRL(an.contratoM2)}</b></div>`:''}</div>`;
  }
  $('contratoBox').innerHTML = h || `<div class="vazio-mini"><p>Cadastre o <b>valor do contrato</b>, a <b>área</b>, o <b>término previsto</b> e o <b>orçamento</b> em Dados da obra para ver aqui: quanto falta receber, previsto × realizado, custo por m² e o andamento do prazo.</p>
    ${!ehProp()?'<button class="btn" type="button" data-irtab="obra">Preencher em Dados da obra</button>':''}</div>`;
  $('kpis').innerHTML = kpisFull(t);
  // vencimentos
  const hoje = hojeIso();
  const pend = todos.filter(ehPendente).sort((a,b)=>(a.venc||'').localeCompare(b.venc||''));
  $('vencs').innerHTML = pend.length ? pend.map(l=>`<tr><td class="${l.venc<hoje?'venc-atraso':''}">${fmtData(l.venc)}${l.venc<hoje?' (vencido)':''}</td><td class="wrap">${badge(l.categoria)} ${esc(l.descricao)}</td>
    <td>${esc(l.fornecedor)}</td><td class="n">${fmtBRL(l.total)}</td><td>${podePagar(l)?`<button class="btn sm pri" data-act="pagar" data-id="${l.id}" type="button">✓ Pago</button>`:''}</td></tr>`).join('')
    : `<tr><td colspan="5" class="muted">Nenhum pagamento pendente.</td></tr>`;
  if (typeof Chart === 'undefined' || !$('tab-resumo').classList.contains('on')) return;
  const css = getComputedStyle(document.documentElement), cv = n => css.getPropertyValue(n).trim();
  const cTxt = cv('--txt'), cBd = cv('--bd'), cCard = cv('--dlg');
  Chart.defaults.color = cTxt; Chart.defaults.borderColor = cBd;
  const eixoR$ = {ticks:{color:cTxt, callback:v=>'R$ '+(+v).toLocaleString('pt-BR',{notation:'compact'})}, grid:{color:cBd}};
  const graf = (id, vazioId, tem, cfg) => { $(vazioId).hidden = tem; $(id).parentElement.hidden = !tem; charts[id] && charts[id].destroy(); charts[id] = tem ? new Chart($(id), cfg) : null; };
  // composição do custo total
  const comp = CAT_TOTAL.filter(k=>t[k]>0), nomeComp = k => k==='apagar' ? 'A pagar (sem categoria)' : CATS[k].nome;
  graf('chComp', 'compVazio', comp.length>0, {type:'doughnut',
    data:{labels:comp.map(nomeComp), datasets:[{data:comp.map(k=>t[k]), backgroundColor:comp.map(k=>CATS[k].cor), borderColor:cCard, borderWidth:2}]},
    options:{animation:false, maintainAspectRatio:false, plugins:{legend:{position:'bottom', labels:{color:cTxt}}, tooltip:{callbacks:{label:c=>`${c.label}: ${fmtBRL(c.raw)} (${pct(c.raw/t.custoTotal)})`}}}}});
  // evolução mensal acumulada: custo × valor pago pelo cliente
  const meses = [...new Set(L.map(l=>(l.categoria==='apagar' ? (l.venc||l.data) : l.data).slice(0,7)))].sort();
  let ac = 0, ar = 0;
  const custoAc = meses.map(m=>{ ac += L.filter(l=>CAT_TOTAL.includes(l.categoria) && (l.categoria==='apagar'?(l.venc||l.data):l.data).slice(0,7)===m).reduce((s,l)=>s+l.total,0); return round2(ac); });
  const recAc = meses.map(m=>{ ar += L.filter(l=>l.categoria==='cliente' && l.data.slice(0,7)===m).reduce((s,l)=>s+l.total,0); return round2(ar); });
  graf('chMes', 'mesVazio', meses.length>0, {type:'line',
    data:{labels:meses.map(fmtMes), datasets:[
      {label:'Custo acumulado', data:custoAc, borderColor:cv('--acc'), backgroundColor:cv('--acc'), tension:.25, pointRadius:3},
      {label:'Pago pelo cliente (acumulado)', data:recAc, borderColor:CATS.cliente.cor, backgroundColor:CATS.cliente.cor, tension:.25, pointRadius:3}]},
    options:{animation:false, maintainAspectRatio:false, interaction:{mode:'index', intersect:false},
      plugins:{legend:{position:'bottom', labels:{color:cTxt}}, tooltip:{callbacks:{label:c=>`${c.dataset.label}: ${fmtBRL(c.raw)}`}}}, scales:{y:eixoR$, x:{ticks:{color:cTxt}, grid:{color:cBd}}}}});
  // custo por etapa
  const et = {}; L.filter(l=>CAT_TOTAL.includes(l.categoria)).forEach(l=>{ const e = l.etapa||'Sem etapa'; et[e] = (et[e]||0) + l.total; });
  const ek = Object.keys(et).sort((a,b)=>et[b]-et[a]);
  graf('chEtapa', 'etapaVazio', ek.length>0, {type:'bar',
    data:{labels:ek, datasets:[{data:ek.map(k=>round2(et[k])), backgroundColor:'#6366f1', borderRadius:6}]},
    options:{animation:false, indexAxis:'y', maintainAspectRatio:false, plugins:{legend:{display:false}, tooltip:{callbacks:{label:c=>`${fmtBRL(c.raw)} (${pct(c.raw/t.custoTotal)})`}}},
      scales:{x:eixoR$, y:{ticks:{color:cTxt}, grid:{color:cBd}}}}});
  // custos dia a dia por subcategoria
  const subs = {}; L.filter(l=>l.categoria==='dia').forEach(l=>{ const s=l.subcat||'Outros'; subs[s]=(subs[s]||0)+l.total; });
  const sk = Object.keys(subs).sort((a,b)=>subs[b]-subs[a]);
  graf('chSub', 'subVazio', sk.length>0, {type:'bar',
    data:{labels:sk, datasets:[{data:sk.map(k=>round2(subs[k])), backgroundColor:CATS.dia.cor, borderRadius:6}]},
    options:{animation:false, indexAxis:'y', maintainAspectRatio:false, plugins:{legend:{display:false}, tooltip:{callbacks:{label:c=>fmtBRL(c.raw)}}},
      scales:{x:eixoR$, y:{ticks:{color:cTxt}, grid:{color:cBd}}}}});
}

/* ---------- lista ---------- */
const COLS_LISTA = [
  {k:'data',h:'Data',f:l=>fmtData(l.data)}, {k:'categoria',h:'Categoria',f:l=>badge(l.categoria)},
  {k:'descricao',h:'Descrição',f:l=>`${esc(l.descricao)}${l._pend?' <span class="tag" title="Ainda não enviado ao Drive">⏳</span>':''}${l.cancelado?` <span class="tag" title="${esc(l.motivoCancel)}">cancelado</span>`:''}`},
  {k:'fornecedor',h:'Fornecedor',f:l=>esc(l.fornecedor)},
  {k:'subcat',h:'Subcat./Tipo',f:l=>esc(l.subcat||l.tipo||'')}, {k:'etapa',h:'Etapa',f:l=>esc(l.etapa||'')}, {k:'forma',h:'Forma',f:l=>esc(l.forma)},
  {k:'qtd',h:'Qtd.',n:1,f:l=>fmtNum(l.qtd)}, {k:'unidade',h:'Un.',f:l=>esc(l.unidade)},
  {k:'vu',h:'V. unit.',n:1,f:l=>fmtBRL(l.vu)}, {k:'total',h:'Total',n:1,f:l=>`<b>${fmtBRL(l.total)}</b>`},
  {k:'venc',h:'Venc./Status',f:l=>ehPendente(l)?`<span class="${l.venc<hojeIso()?'venc-atraso':''}">${fmtData(l.venc)}</span> · <span class="tag">Pendente</span>`:ehPrevistoAPagar(l)?`${esc(l.status)} <span class="tag ok" title="Lançado para pagar depois">a pagar · pago</span>`:esc(l.status)},
  {k:'criadoPor',h:'Lançado por',f:l=>esc(nomeUsuario(l.criadoPor))}
];
function acoesLinha(l){
  let h = '';
  if (l.comprovanteId || l._compPend) h += `<button class="btn sm" data-act="comp" data-id="${l.id}" type="button" title="Ver comprovante">📎</button> `;
  if (l.cancelado) return h;
  if (podePagar(l)) h += `<button class="btn sm pri" data-act="pagar" data-id="${l.id}" type="button">✓ Pago</button> `;
  if (podeEditar(l)) h += `<button class="btn sm" data-act="edit" data-id="${l.id}" type="button" title="Editar">✎</button> `;
  if (catsPermitidas().includes(l.categoria)) h += `<button class="btn sm" data-act="dup" data-id="${l.id}" type="button" title="Duplicar">⧉</button> `;
  if (podeEditar(l)) h += `<button class="btn sm danger" data-act="cancel" data-id="${l.id}" type="button" title="Cancelar lançamento">✕</button>`;
  return h;
}
function renderLista(){
  $('catChips').innerHTML = ['todas',...CAT_ORDER].map(k=>`<button class="chip ${listaCat===k?'on':''}" data-cat="${k}" type="button">${k==='todas'?'Todas':CATS[k].nome}</button>`).join('');
  $('l-agrWrap').hidden = listaCat!=='dia';
  $('l-agr').value = PREFS.agrupamento || 'semana';
  const agr = PREFS.agrupamento || 'semana';
  const ini=$('l-ini').value, fim=$('l-fim').value, sub=$('l-sub').value, forma=$('l-forma').value, q=$('l-txt').value.trim().toLowerCase(), canc=$('l-canc').checked;
  const sit=$('l-sit').value, etapa=$('l-etapa').value;
  const okSit = l => !sit || (sit==='pendente' ? l.status==='Pendente' : sit==='pago' ? l.status!=='Pendente' : ehPrevistoAPagar(l));
  let L = lancObra().filter(l => (canc || !l.cancelado) && (listaCat==='todas'||l.categoria===listaCat) && (!ini||l.data>=ini) && (!fim||l.data<=fim) &&
    (!sub||l.subcat===sub) && (!forma||l.forma===forma) && okSit(l) && (!etapa||l.etapa===etapa) && (!q || [l.descricao,l.fornecedor,l.doc,l.obs,l.etapa].join(' ').toLowerCase().includes(q)));
  L.sort((a,b)=>{ const x=a[sortK], y=b[sortK]; const r = (typeof x==='number'&&typeof y==='number') ? x-y : String(x||'').localeCompare(String(y||''),'pt-BR'); return r*sortD || porData(a,b); });
  $('listaHead').innerHTML = COLS_LISTA.map(c=>`<th class="${c.n?'n':''}" data-sort="${c.k}">${c.h}${sortK===c.k?(sortD>0?' ▲':' ▼'):''}</th>`).join('') + '<th>Ações</th>';
  const linha = l => `<tr class="${l.cancelado?'cancel':''}">${COLS_LISTA.map(c=>`<td class="${c.n?'n':''}">${c.f(l)}</td>`).join('')}<td>${acoesLinha(l)}</td></tr>`;
  const nc = COLS_LISTA.length + 1;
  const somaAt = arr => round2(arr.filter(l=>!l.cancelado).reduce((a,l)=>a+l.total,0));
  let html = '';
  if (!L.length) html = `<tr><td colspan="${nc}" class="muted">Nenhum lançamento encontrado.</td></tr>`;
  else if (listaCat==='dia' && agr!=='nenhum'){
    for (const g of agrupar(L, agr, perObra())){
      const st = somaAt(g.itens);
      html += `<tr class="grp"><td colspan="${nc}">${esc(g.nome)} — ${fmtBRL(st)} <span class="muted">(${g.itens.length} item(ns))</span></td></tr>` + g.itens.map(linha).join('') +
        `<tr class="sub"><td colspan="10" class="n">Subtotal do período</td><td class="n">${fmtBRL(st)}</td><td colspan="3"></td></tr>`;
    }
  } else html = L.map(linha).join('');
  $('listaBody').innerHTML = html;
  $('listaFoot').innerHTML = `<tr><td colspan="10" class="n">${L.filter(l=>!l.cancelado).length} lançamento(s) — Total filtrado</td><td class="n">${fmtBRL(somaAt(L))}</td><td colspan="3"></td></tr>`;
}

/* ---------- histórico ---------- */
const ACAO_NOME = {'lanc.criar':'Lançou', 'lanc.alterar':'Alterou', 'lanc.cancelar':'Cancelou', 'lanc.pagar':'Registrou pagamento', 'comprovante.anexar':'Anexou comprovante',
  'obra.criar':'Cadastrou a obra', 'obra.alterar':'Alterou dados da obra', 'obra.arquivar':'Arquivou a obra', 'periodo.salvar':'Salvou período', 'periodo.excluir':'Excluiu período', 'relatorio.gerar':'Gerou relatório'};
const CAMPO_NOME = {data:'data', descricao:'descrição', categoria:'categoria', forma:'forma', unidade:'unidade', qtd:'qtd.', vu:'valor unit.', total:'total', subcat:'subcategoria', tipo:'tipo', venc:'vencimento', fornecedor:'fornecedor', doc:'documento', etapa:'etapa', obs:'observações', nome:'nome', cidade:'cidade', prop:'proprietário', eng:'engenheiro', ini:'início'};
async function carregarHistorico(){
  const obraId = obraAtualId();
  $('histBody').innerHTML = '<tr><td colspan="5" class="muted">Carregando…</td></tr>';
  try {
    const r = await api('auditoria', {obraId});
    if (obraId !== obraAtualId()) return;
    $('histBody').innerHTML = r.registros.length ? r.registros.map(a=>{
      let antes={}, depois={}; try { antes = a.antes?JSON.parse(a.antes):{}; } catch(e){} try { depois = a.depois?JSON.parse(a.depois):{}; } catch(e){}
      const reg = depois.descricao || antes.descricao || depois.arquivo || depois.nome || antes.nome || '';
      let det = '';
      if (a.acao==='lanc.criar') det = `${CATS[depois.categoria]?CATS[depois.categoria].nome:''} · ${fmtBRL(depois.total)}`;
      else if (a.acao==='lanc.cancelar') det = `Motivo: ${depois.motivoCancel||''}`;
      else if (a.acao==='lanc.pagar') det = antes.categoria==='apagar' ? `→ ${CATS[depois.categoria]?CATS[depois.categoria].nome:''} em ${fmtData(depois.data)}` : `Pago via ${depois.forma} · ${fmtBRL(depois.total)}`;
      else if (a.acao==='lanc.alterar' || a.acao==='obra.alterar') det = Object.keys(CAMPO_NOME).filter(k=>k in depois && String(antes[k]??'')!==String(depois[k]??''))
        .map(k=>`${CAMPO_NOME[k]}: ${k==='total'||k==='vu'?fmtBRL(antes[k]):esc(antes[k]??'')} → ${k==='total'||k==='vu'?fmtBRL(depois[k]):esc(depois[k]??'')}`).join('; ');
      return `<tr><td>${fmtDataHora(a.quando)}</td><td>${esc(a.usuario)}</td><td>${esc(ACAO_NOME[a.acao]||a.acao)}</td><td class="wrap">${esc(reg)}</td><td class="wrap">${a.acao.endsWith('alterar')?det:esc(det)}</td></tr>`;
    }).join('') : '<tr><td colspan="5" class="muted">Sem registros ainda (lançamentos ainda não enviados não aparecem aqui).</td></tr>';
  } catch(e){ $('histBody').innerHTML = `<tr><td colspan="5" class="muted">${esc(e instanceof ErroRede ? 'Sem conexão. O histórico é consultado direto no servidor.' : e.message)}</td></tr>`; }
}

/* ---------- dados da obra ---------- */
const fmtValor = n => (+n) ? (+n).toLocaleString('pt-BR',{minimumFractionDigits:2, maximumFractionDigits:2}) : '';
const CAMPOS_OBRA = ['o-nome','o-cidade','o-prop','o-eng','o-ini','o-fim','o-contrato','o-area','o-orc-mo','o-orc-material','o-orc-dia','o-orc-salario'];
function preencherDadosObra(){
  const o = obraAtual(); if (!o) return;
  $('o-nome').value=o.nome; $('o-cidade').value=o.cidade||''; $('o-prop').value=o.prop||''; $('o-eng').value=o.eng||''; $('o-ini').value=o.ini||'';
  $('o-fim').value=o.fim||''; $('o-contrato').value=fmtValor(o.contrato); $('o-area').value=(+o.area)?String(o.area).replace('.',','):'';
  ORC_CATS.forEach(k=>$('o-orc-'+k).value = fmtValor((o.orcamento||{})[k])); somarOrcamento();
}
function somarOrcamento(){
  const tot = ORC_CATS.reduce((s,k)=>s+(parseNum($('o-orc-'+k).value)||0),0);
  $('o-orc-total').value = tot ? fmtBRL(tot) : '';
}
function lerDadosObra(){
  const num = id => { const v = $(id).value.trim(); if (!v) return 0; const n = parseNum(v); return isFinite(n) && n >= 0 ? round2(n) : NaN; };
  const d = {nome:$('o-nome').value.trim(), cidade:$('o-cidade').value.trim(), prop:$('o-prop').value.trim(), eng:$('o-eng').value.trim(), ini:$('o-ini').value,
    fim:$('o-fim').value, contrato:num('o-contrato'), area:num('o-area'), orcamento:{}};
  ORC_CATS.forEach(k=>d.orcamento[k] = num('o-orc-'+k));
  if (!d.nome) return 'Informe o nome da obra.';
  if ([d.contrato, d.area, ...Object.values(d.orcamento)].some(isNaN)) return 'Confira os valores: use só números (ex.: 380.000,00).';
  if (d.ini && d.fim && d.fim < d.ini) return 'O término previsto deve ser depois do início.';
  return d;
}
async function salvarObra(){
  const d = lerDadosObra(); if (typeof d === 'string'){ $('o-erro').textContent = d; return; }
  $('o-erro').textContent = '';
  if (BASE && (BASE.api||1) < 3 && (d.contrato || d.area || d.fim || ORC_CATS.some(k=>d.orcamento[k]))){ $('o-erro').textContent = 'O servidor ainda não guarda contrato e orçamento. O administrador precisa concluir a Parte 1 da atualização (Google).'; return; }
  const o = obraAtual();
  await enfileirar('obra.salvar', {id:o.id, ...d});
  renderObra(); document.title = `${d.nome} — Controle de Obras`; toast('Dados da obra salvos'); sincronizar();
}
function renderDadosObra(){
  const pode = !ehProp();
  CAMPOS_OBRA.forEach(i=>$(i).disabled=!pode); document.querySelectorAll('.o-salvar').forEach(b=>b.hidden = !pode);
  $('perForm').hidden = !pode; $('cardArquivar').hidden = !ehAdmin();
  const P = perObra();
  $('perList').innerHTML = P.length ? P.map(p=>`<tr><td><b>${esc(p.nome)}</b></td><td>${fmtData(p.ini)} – ${fmtData(p.fim)}</td>
    <td>${pode?`<button class="btn sm danger" data-act="delper" data-id="${p.id}" type="button">Remover</button>`:''}</td></tr>`).join('')
    : `<tr><td class="muted">Nenhum período cadastrado.</td></tr>`;
}

/* ---------- equipe: chamada diária, mapa de presença, pagamento e cadastro ---------- */
const funcObra = todos => S.func.filter(f=>f.obraId===obraAtualId() && (todos || f.ativo!==false)).sort((a,b)=>a.nome.localeCompare(b.nome,'pt-BR'));
const presObra = () => S.presencas.filter(p=>p.obraId===obraAtualId());
const iniciais = n => String(n||'?').trim().split(/\s+/).filter(Boolean).slice(0,2).map(x=>x[0]).join('').toUpperCase();
const podeEquipe = () => !ehProp();
let chamada = {data:'', marcas:{}}, funcEditando = null;
function exigeApi4(elErro){
  if (BASE && (BASE.api||1) < 4){ const m = 'O servidor ainda não guarda a equipe. O administrador precisa concluir a Parte 1 da atualização (Google).'; if (elErro) elErro.textContent = m; else toast(m); return false; }
  return true;
}
function presencaSalva(funcId, data){ return S.presencas.find(p=>p.obraId===obraAtualId() && p.funcId===funcId && p.data===data); }
function marcaAtual(funcId){
  if (funcId in chamada.marcas) return chamada.marcas[funcId];
  const p = presencaSalva(funcId, chamada.data); return p ? +p.fracao : null;
}
const chamadaSuja = () => Object.keys(chamada.marcas).length > 0;
function trocarDiaChamada(iso){
  if (!iso) return;
  if (chamadaSuja() && iso !== chamada.data && !confirm('Há marcações não salvas neste dia. Descartar?')){ $('eq-data').value = chamada.data; return; }
  chamada = {data:iso, marcas:{}}; renderEquipe();
}
function renderEquipe(){
  if (!obraAtualId()) return;
  if (!chamada.data) chamada.data = hojeIso();
  $('eq-data').value = chamada.data;
  const F = funcObra(false), FT = funcObra(true), pode = podeEquipe();
  ['eq-acoes','cardFolha','fu-form','fu-acoes'].forEach(id=>$(id).hidden = !pode);
  $('fu-titulo').textContent = pode ? (funcEditando ? 'Editar funcionário' : 'Cadastrar funcionário') : 'Funcionários da obra';
  // chamada
  const dow = isoToDate(chamada.data).toLocaleDateString('pt-BR',{weekday:'long'});
  let pres = 0, meio = 0, falta = 0, custo = 0, semMarca = 0;
  $('eq-lista').innerHTML = F.length ? F.map(f=>{
    const m = marcaAtual(f.id), salvo = presencaSalva(f.id, chamada.data), pago = salvo && salvo.lancId;
    const diaria = salvo && +salvo.fracao ? +salvo.diaria : f.diaria;
    if (m===1) pres++; else if (m===0.5) meio++; else if (m===0) falta++; else semMarca++;
    if (m) custo += m*diaria;
    const bt = (v, rot) => `<button type="button" class="${PRES[String(v)].cls} ${m===v?'on':''}" data-pres="${v}" data-func="${f.id}" aria-pressed="${m===v}" ${pago||!pode?'disabled':''}>${rot}</button>`;
    return `<div class="eq-item ${f.id in chamada.marcas?'mudou':''}">
      <div class="eq-nome"><span class="avatar">${esc(iniciais(f.nome))}</span><div><b>${esc(f.nome)}</b><small>${esc(f.funcao||'Sem função')} · ${fmtBRL(diaria)}/dia${pago?' · <span class="tag ok">pago</span>':''}${salvo&&salvo._pend?' <span class="tag">⏳</span>':''}</small></div></div>
      <div class="seg" role="group" aria-label="Presença de ${esc(f.nome)}">${bt(1,'Presente')}${bt(0.5,'½ dia')}${bt(0,'Falta')}</div></div>`;
  }).join('') : `<div class="vazio-mini"><p><b>Nenhum funcionário ativo nesta obra.</b> ${pode?'Cadastre a equipe no quadro "Cadastrar funcionário", logo abaixo.':''}</p></div>`;
  $('eq-resumoDia').innerHTML = F.length ? `<span class="dia-sem">${esc(dow)}</span>
    <span class="pill p1">${pres} presente(s)</span>${meio?`<span class="pill p05">${meio} meio dia</span>`:''}${falta?`<span class="pill p0">${falta} falta(s)</span>`:''}${semMarca?`<span class="pill">${semMarca} sem marcação</span>`:''}
    <span class="pill custo">Custo do dia ${fmtBRL(custo)}</span>` : '';
  $('eq-status').textContent = chamadaSuja() ? `${Object.keys(chamada.marcas).length} alteração(ões) não salva(s)` : '';
  $('eq-salvar').disabled = !chamadaSuja();
  // indicadores
  const eq = equipeTotais(obraAtualId()), hoje = hojeIso();
  const presHoje = S.presencas.filter(p=>p.obraId===obraAtualId() && p.data===hoje && +p.fracao>0).length;
  $('eq-kpis').innerHTML = kpiHTML('Diárias a pagar', eq.aPagar, CATS.apagar.cor, eq.aPagar ? `${fmtNum(eq.diasAPagar)} dia(s) · ${eq.funcAPagar} funcionário(s) · desde ${fmtData(eq.maisAntigo).slice(0,5)}` : 'tudo pago') +
    kpiHTML('Diárias já lançadas em Salário', eq.pago, CATS.salario.cor, `${fmtNum(eq.dias)} dia(s) trabalhados no total`) +
    `<div class="kpi" style="--c:#8b5cf6"><div class="l">Equipe</div><div class="v">${F.length} ativo(s)</div><div class="s">${presHoje} presente(s) hoje${FT.length>F.length?` · ${FT.length-F.length} inativo(s)`:''}</div></div>`;
  renderFolha(); renderMapa(); renderFuncs();
}
function marcar(funcId, v){
  const salvo = presencaSalva(funcId, chamada.data);
  if (salvo && +salvo.fracao===v) delete chamada.marcas[funcId]; else chamada.marcas[funcId] = v;
  renderEquipe();
}
function todosPresentes(){
  funcObra(false).forEach(f=>{ const m = marcaAtual(f.id), s = presencaSalva(f.id, chamada.data); if (m==null && !(s && s.lancId)) chamada.marcas[f.id] = 1; });
  renderEquipe();
}
async function salvarChamada(){
  if (!exigeApi4($('eq-erro'))) return;
  const itens = Object.entries(chamada.marcas).map(([funcId, fracao])=>({funcId, fracao}));
  if (!itens.length) return;
  $('eq-erro').textContent = '';
  await enfileirar('presenca.salvar', {obraId:obraAtualId(), data:chamada.data, itens});
  const n = itens.filter(i=>i.fracao>0).length;
  chamada.marcas = {}; renderObra(); toast(`Chamada de ${fmtData(chamada.data)} salva — ${n} com presença` + (navigator.onLine ? '' : ' (será enviada quando houver internet)')); sincronizar();
}
/* pagamento das diárias */
function diasAPagar(funcId, ini, fim){
  return presObra().filter(p=>p.funcId===funcId && !p.lancId && +p.fracao>0 && (!ini || p.data>=ini) && (!fim || p.data<=fim)).sort((a,b)=>a.data.localeCompare(b.data));
}
let folhaSel = {};
function renderFolha(){
  if (!$('fo-ini').value){ const eq = equipeTotais(obraAtualId()); $('fo-ini').value = eq.maisAntigo || hojeIso().slice(0,8)+'01'; }
  if (!$('fo-fim').value) $('fo-fim').value = hojeIso();
  if (!$('fo-data').value) $('fo-data').value = hojeIso();
  fillSelect($('fo-forma'), S.cfg.formas);
  $('fo-vencWrap').hidden = $('fo-forma').value !== FORMA_PEND;
  const ini = $('fo-ini').value, fim = $('fo-fim').value;
  const linhas = funcObra(true).map(f=>({f, dias:diasAPagar(f.id, ini, fim)})).filter(x=>x.dias.length);
  let tot = 0, qd = 0;
  $('fo-lista').innerHTML = linhas.length ? linhas.map(({f, dias})=>{
    const r = resumoDiarias(dias), on = folhaSel[f.id] !== false;
    if (on){ tot += r.total; qd += r.dias; }
    return `<tr><td><input type="checkbox" data-folha="${f.id}" ${on?'checked':''} aria-label="Pagar ${esc(f.nome)}"></td><td><b>${esc(f.nome)}</b><br><small class="muted">${esc(f.funcao||'')}</small></td>
      <td class="n">${fmtNum(r.dias)}</td><td class="wrap muted">${esc(dias.map(p=>fmtData(p.data).slice(0,5)+(+p.fracao===0.5?'½':'')).join(' · '))}</td>
      <td class="n"><b>${fmtBRL(r.total)}</b></td><td class="wrap muted">${esc(f.pix||'')}</td></tr>`;
  }).join('') : `<tr><td colspan="6" class="muted">Nenhuma diária a pagar entre ${fmtData(ini)} e ${fmtData(fim)}.</td></tr>`;
  $('fo-foot').innerHTML = linhas.length ? `<tr><td></td><td>Total selecionado</td><td class="n">${fmtNum(qd)}</td><td></td><td class="n">${fmtBRL(tot)}</td><td></td></tr>` : '';
  $('fo-gerar').disabled = !linhas.length || !tot;
  $('fo-gerar').textContent = tot ? `Lançar ${fmtBRL(tot)} em Salário` : 'Lançar pagamento em Salário';
}
async function gerarFolha(){
  if (!exigeApi4($('fo-erro'))) return;
  const ini = $('fo-ini').value, fim = $('fo-fim').value, data = $('fo-data').value, forma = $('fo-forma').value, venc = $('fo-venc').value;
  if (!ini || !fim || fim < ini){ $('fo-erro').textContent = 'Confira o período (de / até).'; return; }
  if (!data || !forma){ $('fo-erro').textContent = 'Informe a data e a forma de pagamento.'; return; }
  if (forma===FORMA_PEND && !venc){ $('fo-erro').textContent = 'Informe a data prevista de pagamento.'; return; }
  const sel = funcObra(true).filter(f=>folhaSel[f.id]!==false && diasAPagar(f.id, ini, fim).length);
  if (!sel.length){ $('fo-erro').textContent = 'Selecione ao menos um funcionário.'; return; }
  const total = sel.reduce((s,f)=>s+resumoDiarias(diasAPagar(f.id, ini, fim)).total,0);
  if (!confirm(`Lançar ${sel.length} pagamento(s) de diárias, somando ${fmtBRL(total)}, na categoria Salário?\n\nPeríodo: ${fmtData(ini)} a ${fmtData(fim)} · ${forma}`)) return;
  $('fo-erro').textContent = '';
  await enfileirar('folha.gerar', {obraId:obraAtualId(), ini, fim, data, forma, venc: forma===FORMA_PEND ? venc : '', itens: sel.map(f=>({funcId:f.id, lancId:uid()}))});
  folhaSel = {}; renderObra(); toast(`Diárias lançadas em Salário — ${fmtBRL(total)}`); sincronizar();
}
/* mapa mensal */
function renderMapa(){
  const mes = $('mp-mes').value || chamada.data.slice(0,7); $('mp-mes').value = mes;
  const [y, m] = mes.split('-').map(Number), nd = new Date(y, m, 0).getDate(), hoje = hojeIso();
  const F = funcObra(true).filter(f=>f.ativo!==false || presObra().some(p=>p.funcId===f.id && p.data.startsWith(mes)));
  const dias = Array.from({length:nd}, (_,i)=>`${mes}-${String(i+1).padStart(2,'0')}`);
  const ini = d => isoToDate(d).toLocaleDateString('pt-BR',{weekday:'narrow'});
  $('mp-head').innerHTML = `<tr><th class="fx">Funcionário</th>${dias.map(d=>`<th class="d ${isoToDate(d).getDay()===0?'dom':''} ${d===hoje?'hoje':''}" title="${fmtData(d)}">${+d.slice(8)}<small>${ini(d)}</small></th>`).join('')}<th class="n">Dias</th><th class="n">Valor</th></tr>`;
  $('mp-body').innerHTML = F.length ? F.map(f=>{
    const P = new Map(presObra().filter(p=>p.funcId===f.id && p.data.startsWith(mes)).map(p=>[p.data, p]));
    let qd = 0, val = 0;
    const cel = dias.map(d=>{ const p = P.get(d); if (!p) return `<td class="d ${isoToDate(d).getDay()===0?'dom':''}" data-dia="${d}"></td>`;
      const k = PRES[String(+p.fracao)] || PRES['0']; qd += +p.fracao; val += valorDia(p);
      return `<td class="d ${k.cls} ${p.lancId?'pg':''}" data-dia="${d}" title="${fmtData(d)} — ${k.rot}${p.lancId?' (pago)':''}">${k.curto}</td>`; }).join('');
    return `<tr><td class="fx"><b>${esc(f.nome)}</b><small>${esc(f.funcao||'')}</small></td>${cel}<td class="n">${fmtNum(qd)}</td><td class="n">${fmtBRL(val)}</td></tr>`;
  }).join('') : `<tr><td class="muted" colspan="${nd+3}">Sem funcionários cadastrados.</td></tr>`;
}
/* cadastro */
function renderFuncs(){
  $('dl-funcao').innerHTML = FUNCOES.map(x=>`<option value="${esc(x)}">`).join('');
  const P = presObra(), pode = podeEquipe();
  const FT = funcObra(true);
  $('fu-lista').innerHTML = FT.length ? FT.map(f=>{
    const Pf = P.filter(p=>p.funcId===f.id && +p.fracao>0), pago = round2(Pf.filter(p=>p.lancId).reduce((s,p)=>s+valorDia(p),0)), ap = round2(Pf.filter(p=>!p.lancId).reduce((s,p)=>s+valorDia(p),0));
    return `<tr class="${f.ativo===false?'inativo':''}"><td><span class="avatar sm">${esc(iniciais(f.nome))}</span> <b>${esc(f.nome)}</b>${f.ativo===false?' <span class="tag">inativo</span>':''}${f._pend?' <span class="tag">⏳</span>':''}</td>
      <td>${esc(f.funcao||'')}</td><td class="n">${fmtBRL(f.diaria)}</td><td class="n">${fmtNum(Pf.reduce((s,p)=>s+(+p.fracao),0))}</td><td class="n">${fmtBRL(pago)}</td>
      <td class="n ${ap?'venc-atraso':''}">${fmtBRL(ap)}</td><td class="wrap">${esc([f.pix, f.telefone].filter(Boolean).join(' · '))}</td>
      <td>${pode?`<button class="btn sm" data-act="editFunc" data-id="${f.id}" type="button">Editar</button> <button class="btn sm" data-act="ativoFunc" data-id="${f.id}" type="button">${f.ativo===false?'Reativar':'Inativar'}</button>`:''}</td></tr>`;
  }).join('') : `<tr><td colspan="8" class="muted">Nenhum funcionário cadastrado.</td></tr>`;
}
function limparFunc(){
  funcEditando = null; ['fu-nome','fu-funcao','fu-diaria','fu-pix','fu-tel'].forEach(i=>$(i).value=''); $('fu-ativo').checked = true; $('fu-erro').textContent = '';
  $('fu-titulo').textContent = 'Cadastrar funcionário'; $('fu-salvar').textContent = 'Salvar funcionário';
}
function editarFunc(id){
  const f = S.func.find(x=>x.id===id); if (!f) return;
  funcEditando = id; $('fu-nome').value = f.nome; $('fu-funcao').value = f.funcao||''; $('fu-diaria').value = fmtValor(f.diaria); $('fu-pix').value = f.pix||''; $('fu-tel').value = f.telefone||'';
  $('fu-ativo').checked = f.ativo!==false; $('fu-titulo').textContent = 'Editar funcionário'; $('fu-salvar').textContent = 'Atualizar funcionário'; $('fu-erro').textContent = '';
  $('cardFunc').scrollIntoView({behavior:'smooth', block:'start'}); $('fu-nome').focus();
}
async function salvarFunc(){
  if (!exigeApi4($('fu-erro'))) return;
  const nome = $('fu-nome').value.trim(), diaria = parseNum($('fu-diaria').value);
  if (!nome){ $('fu-erro').textContent = 'Informe o nome.'; return; }
  if (!(diaria > 0)){ $('fu-erro').textContent = 'Informe o valor da diária (ex.: 150,00).'; return; }
  if (!funcEditando && funcObra(true).some(f=>f.nome.toLowerCase()===nome.toLowerCase()) && !confirm(`Já existe "${nome}" nesta obra. Cadastrar mesmo assim?`)) return;
  const id = funcEditando || uid();
  const f = S.func.find(x=>x.id===id);
  if (f && round2(diaria) !== round2(f.diaria)) toast('O novo valor da diária vale para as próximas chamadas; dias já marcados mantêm o valor anterior.');
  await enfileirar('func.salvar', {id, obraId:obraAtualId(), nome, funcao:$('fu-funcao').value.trim(), diaria:round2(diaria), pix:$('fu-pix').value.trim(), telefone:$('fu-tel').value.trim(), ativo:$('fu-ativo').checked});
  const editou = !!funcEditando; limparFunc(); renderObra(); if (!editou) toast(`${nome} cadastrado(a) na equipe`); sincronizar();
}
async function alternarAtivoFunc(id){
  const f = S.func.find(x=>x.id===id); if (!f || !exigeApi4()) return;
  const ativo = f.ativo===false;
  if (!ativo && !confirm(`Inativar ${f.nome}? Ele(a) sai da chamada diária, mas o histórico e as diárias a pagar continuam.`)) return;
  await enfileirar('func.salvar', {id, obraId:f.obraId, nome:f.nome, funcao:f.funcao||'', diaria:f.diaria, pix:f.pix||'', telefone:f.telefone||'', ativo});
  renderObra(); toast(`${f.nome} ${ativo?'reativado(a)':'inativado(a)'}`); sincronizar();
}

/* ---------- exclusão de obra (administrador, requer internet) ---------- */
let excluindo = null;
function abrirExclusao(id, nome, info){
  excluindo = {id, nome}; $('ex-nome').textContent = nome; $('ex-info').textContent = info || ''; $('ex-conf').value = ''; $('ex-erro').textContent = ''; $('ex-ok').disabled = true;
  $('dlgExcluir').showModal(); $('ex-conf').focus();
}
async function confirmarExclusao(){
  if (!excluindo) return;
  if (BASE && (BASE.api||1) < 4){ $('ex-erro').textContent = 'O servidor ainda não exclui obras. Conclua a Parte 1 da atualização (Google).'; return; }
  $('ex-ok').disabled = true; $('ex-erro').textContent = 'Excluindo…';
  try {
    await api('obraStatus', {id:excluindo.id, acao:'excluir', confirmacao:$('ex-conf').value});
    $('dlgExcluir').close(); toast(`Obra "${excluindo.nome}" excluída. Ela pode ser restaurada no painel do administrador.`);
    const eraAtual = obraAtualId()===excluindo.id; excluindo = null;
    await sincronizar(true);
    if (eraAtual) irInicio(); else if (location.hash==='#/admin') carregarObrasAdmin();
  } catch(e){ $('ex-erro').textContent = e instanceof ErroRede ? 'Sem conexão. Excluir uma obra requer internet.' : e.message; $('ex-ok').disabled = false; }
}

/* ---------- ações ---------- */
async function acao(act, id){
  const l = S.lanc.find(x=>x.id===id);
  if (act==='edit' && l && podeEditar(l)){ preencherForm(l); editingId=id; $('formTitulo').textContent='Editando lançamento'; $('btnSalvar').textContent='Atualizar'; $('btnCancelar').hidden=false; abrirTab('lancar'); window.scrollTo({top:0,behavior:'smooth'}); }
  if (act==='dup' && l){ limparForm(false); preencherForm({...l, data:hojeIso(), mesRef:mesRefDe(hojeIso())}); abrirTab('lancar'); window.scrollTo({top:0,behavior:'smooth'}); toast('Cópia carregada no formulário — revise e salve'); }
  if (act==='cancel' && l && podeEditar(l)){ cancelandoId=id; $('cn-info').textContent=`${fmtData(l.data)} — ${l.descricao} — ${fmtBRL(l.total)}`; $('cn-motivo').value=''; $('cn-erro').textContent=''; $('dlgCancelar').showModal(); }
  if (act==='comp') verComprovante(id);
  if (act==='pagar' && l){
    const aPrazo = l.categoria!=='apagar';
    pagandoId=id; $('pg-info').textContent = aPrazo
      ? `${CATS[l.categoria].nome}: ${l.descricao} — ${fmtBRL(l.total)} (previsto para ${fmtData(l.venc)}). Informe quando e como foi pago.`
      : `${l.descricao} — ${fmtBRL(l.total)} (venc. ${fmtData(l.venc)})`;
    $('pg-cat').closest('.fld').hidden = aPrazo;
    $('pg-cat').selectedIndex = 0; $('pg-data').value = hojeIso(); $('pg-sub').value='';
    $('pg-forma').value = (l.forma && l.forma!==FORMA_PEND) ? l.forma : $('pg-forma').options[0].value;
    $('pg-subWrap').hidden = true; $('dlgPago').showModal();
  }
  if (act==='delper' && confirm('Remover este período?')){ await enfileirar('periodo.excluir', {id}); renderObra(); sincronizar(); }
  if (act==='resetSenha') resetSenhaUsuario(id);
  if (act==='encerrar') encerrarSessoes(id);
  if (act==='editUser') editarUsuario(id);
  if (act==='editFunc') editarFunc(id);
  if (act==='ativoFunc') alternarAtivoFunc(id);
  if (act==='obAbrir') irObra(id);
  if (act==='obArquivar') statusObra(id, 'arquivar');
  if (act==='obReativar') statusObra(id, 'reativar');
  if (act==='obExcluir') statusObra(id, 'excluir');
  if (act==='obRestaurar') statusObra(id, 'restaurar');
}
async function confirmarCancelamento(){
  const motivo = $('cn-motivo').value.trim();
  if (motivo.length < 3){ $('cn-erro').textContent = 'Informe o motivo.'; return; }
  await enfileirar('lanc.cancelar', {id:cancelandoId, motivo});
  $('dlgCancelar').close(); renderObra(); toast('Lançamento cancelado'); sincronizar();
}
async function confirmarPago(){
  const l = S.lanc.find(x=>x.id===pagandoId); if (!l) return;
  const cat=$('pg-cat').value, data=$('pg-data').value;
  if (!data){ alert('Informe a data do pagamento.'); return; }
  if (l.categoria!=='apagar'){
    await enfileirar('lanc.pagar', {id:pagandoId, data, forma:$('pg-forma').value});
    $('dlgPago').close(); renderObra(); toast(`Pagamento registrado (${$('pg-forma').value})`); sincronizar(); return;
  }
  if (cat==='dia' && !$('pg-sub').value){ alert('Selecione a subcategoria.'); return; }
  await enfileirar('lanc.pagar', {id:pagandoId, categoria:cat, data, forma:$('pg-forma').value, subcat:cat==='dia'?$('pg-sub').value:''});
  $('dlgPago').close(); renderObra(); toast(`Pagamento registrado em ${CATS[cat].nome}`); sincronizar();
}
function abrirTab(t){
  document.querySelectorAll('#view-obra nav button').forEach(b=>b.classList.toggle('on', b.dataset.tab===t));
  document.querySelectorAll('section.tab').forEach(s=>s.classList.toggle('on', s.id==='tab-'+t));
  if (t==='resumo') renderResumo();
  if (t==='hist') carregarHistorico();
  if (t==='equipe') renderEquipe();
}
async function gerarExcel(){
  if (typeof XLSX === 'undefined'){ alert('Componente do Excel não carregou. Recarregue a página.'); return; }
  const o = obraAtual();
  const wb = construirWorkbook(o, ativos(), PREFS.agrupamento||'semana', perObra(), {func:funcObra(true), pres:presObra()});
  const d = hojeIso().split('-').reverse().join('-');
  const nome = `Controle de Gastos - ${o.nome.replace(/[\\/:*?"<>|]/g,'-')} - ${d}.xlsx`;
  try { XLSX.writeFile(wb, nome); } catch(e){ /* download bloqueado pelo navegador */ }
  if (window.__DEMO__){ toast('Na demonstração o download pode ser bloqueado. Um Excel de exemplo foi enviado na conversa.'); return; }
  await enfileirar('relatorio.salvar', {obraId:o.id, nome, base64:XLSX.write(wb, {type:'base64', bookType:'xlsx'})});
  toast('Relatório gerado. Uma cópia será guardada na pasta da obra no Drive.');
  sincronizar();
}

/* =====================================================================
   ADMINISTRAÇÃO DE USUÁRIOS
   ===================================================================== */
let USUARIOS = [], OBRAS_ADM = [];
async function carregarUsuarios(){
  $('uLista').innerHTML = '<tr><td colspan="7" class="muted">Carregando…</td></tr>';
  try {
    const r = await api('usuarios'); USUARIOS = r.usuarios; OBRAS_ADM = r.obras;
    renderUsuarios(); novoUsuario();
  } catch(e){ $('uLista').innerHTML = `<tr><td colspan="7" class="muted">${esc(e instanceof ErroRede ? 'Sem conexão. A gestão de usuários requer internet.' : e.message)}</td></tr>`; }
}
function renderUsuarios(){
  const nomeObra = id => (OBRAS_ADM.find(o=>o.id===id)||{}).nome || '';
  $('uLista').innerHTML = USUARIOS.map(u=>`<tr><td>${esc(u.nome)}</td><td>${esc(u.login)}</td><td>${PERFIL_NOME[u.perfil]}</td>
    <td class="wrap">${u.perfil==='admin'?'Todas':esc(u.obras.map(nomeObra).filter(Boolean).join(', ')||'—')}</td>
    <td>${u.ultimoAcesso?fmtDataHora(u.ultimoAcesso):'nunca'}</td>
    <td>${u.ativo?(u.trocarSenha?'<span class="tag">senha provisória</span>':'<span class="tag ok">ativo</span>'):'<span class="tag">inativo</span>'}</td>
    <td><button class="btn sm" data-act="editUser" data-id="${u.id}" type="button">Editar</button>
      <button class="btn sm" data-act="resetSenha" data-id="${u.id}" type="button">Nova senha</button>
      <button class="btn sm" data-act="encerrar" data-id="${u.id}" type="button" title="Desconecta o usuário de todos os aparelhos">Encerrar sessões</button></td></tr>`).join('');
}
function renderObrasCheck(sel){
  $('u-obras').innerHTML = OBRAS_ADM.length ? OBRAS_ADM.map(o=>`<label class="chk"><input type="checkbox" value="${o.id}" ${sel.includes(o.id)?'checked':''}> ${esc(o.nome)}</label>`).join('')
    : '<p class="muted">Nenhuma obra cadastrada.</p>';
  $('u-obrasWrap').hidden = $('u-perfil').value==='admin';
}
function novoUsuario(){
  usuarioEditando = null; $('uTitulo').textContent='Novo usuário';
  ['u-nome','u-login','u-email'].forEach(i=>$(i).value=''); $('u-perfil').value='engenheiro'; $('u-ativo').checked=true; $('u-erro').textContent='';
  renderObrasCheck([]);
}
function editarUsuario(id){
  const u = USUARIOS.find(x=>x.id===id); if (!u) return;
  usuarioEditando = id; $('uTitulo').textContent = 'Editar: ' + u.nome;
  $('u-nome').value=u.nome; $('u-login').value=u.login; $('u-email').value=u.email||''; $('u-perfil').value=u.perfil; $('u-ativo').checked=u.ativo; $('u-erro').textContent='';
  renderObrasCheck(u.obras); window.scrollTo({top:0,behavior:'smooth'});
}
async function salvarUsuario(){
  const dados = {id:usuarioEditando||undefined, nome:$('u-nome').value.trim(), login:$('u-login').value.trim().toLowerCase(), email:$('u-email').value.trim(),
    perfil:$('u-perfil').value, ativo:$('u-ativo').checked, obras:[...document.querySelectorAll('#u-obras input:checked')].map(i=>i.value)};
  if (!dados.nome || !dados.login){ $('u-erro').textContent='Informe nome e usuário.'; return; }
  if (dados.perfil!=='admin' && !dados.obras.length && !confirm('Nenhuma obra marcada: o usuário não verá nenhuma obra. Continuar?')) return;
  $('u-salvar').disabled = true; $('u-erro').textContent = 'Salvando…';
  try {
    const r = await api('usuarioSalvar', dados);
    $('u-erro').textContent = '';
    if (r.senhaProvisoria) mostrarSenha(dados.login, r.senhaProvisoria, 'Usuário criado');
    else toast('Usuário atualizado');
    await carregarUsuarios();
  } catch(e){ $('u-erro').textContent = e instanceof ErroRede ? 'Sem conexão.' : e.message; }
  finally { $('u-salvar').disabled = false; }
}
function mostrarSenha(login, senha, titulo){
  $('sp-titulo').textContent = titulo; $('sp-info').textContent = `Usuário: ${login}`; $('sp-senha').textContent = senha; $('dlgSenha').showModal();
}
async function resetSenhaUsuario(id){
  const u = USUARIOS.find(x=>x.id===id); if (!u || !confirm(`Gerar nova senha provisória para ${u.nome}? A senha atual deixa de funcionar e as sessões abertas são encerradas.`)) return;
  try { const r = await api('usuarioResetSenha', {id}); mostrarSenha(u.login, r.senhaProvisoria, 'Nova senha provisória'); carregarUsuarios(); }
  catch(e){ toast(e.message); }
}
async function encerrarSessoes(id){
  const u = USUARIOS.find(x=>x.id===id); if (!u || !confirm(`Desconectar ${u.nome} de todos os aparelhos? Use em caso de celular perdido ou suspeita de acesso indevido.`)) return;
  try { await api('usuarioEncerrarSessoes', {id}); toast('Sessões encerradas'); } catch(e){ toast(e.message); }
}
/* ---------- painel do administrador: obras ---------- */
let OBRAS_TODAS = [], abaAdmin = 'obras';
const SIT_OBRA = {ativa:['Ativa','ok'], arquivada:['Arquivada',''], excluida:['Excluída','bad']};
function abrirAbaAdmin(a){
  abaAdmin = a;
  document.querySelectorAll('[data-adm]').forEach(b=>{ b.classList.toggle('on', b.dataset.adm===a); b.setAttribute('aria-selected', b.dataset.adm===a); });
  $('adm-obras').hidden = a!=='obras'; $('adm-usuarios').hidden = a!=='usuarios';
}
async function carregarObrasAdmin(){
  if (BASE && (BASE.api||1) < 4){
    $('obLista').innerHTML = '<tr><td colspan="7" class="muted">Para gerenciar as obras aqui, conclua a Parte 1 da atualização (Google).</td></tr>'; return; }
  $('obLista').innerHTML = '<tr><td colspan="7" class="muted">Carregando…</td></tr>';
  try { const r = await api('obrasAdmin'); OBRAS_TODAS = r.obras; renderObrasAdmin(); }
  catch(e){ $('obLista').innerHTML = `<tr><td colspan="7" class="muted">${esc(e instanceof ErroRede ? 'Sem conexão. O painel do administrador requer internet.' : e.message)}</td></tr>`; }
}
function renderObrasAdmin(){
  const filtro = $('ob-filtro').value;
  const L = OBRAS_TODAS.filter(o=>!filtro || o.situacao===filtro).sort((a,b)=>(a.situacao==='excluida')-(b.situacao==='excluida') || a.nome.localeCompare(b.nome,'pt-BR'));
  const cont = s => OBRAS_TODAS.filter(o=>o.situacao===s).length;
  $('ob-resumo').textContent = `${cont('ativa')} ativa(s) · ${cont('arquivada')} arquivada(s) · ${cont('excluida')} excluída(s)`;
  $('obLista').innerHTML = L.length ? L.map(o=>{
    const [rot, cls] = SIT_OBRA[o.situacao];
    const b = (act, txt, extra) => `<button class="btn sm ${extra||''}" data-act="${act}" data-id="${o.id}" type="button">${txt}</button>`;
    const acoes = o.situacao==='ativa' ? b('obAbrir','Abrir') + ' ' + b('obArquivar','Arquivar') + ' ' + b('obExcluir','Excluir','danger')
      : o.situacao==='arquivada' ? b('obReativar','Reativar') + ' ' + b('obExcluir','Excluir','danger')
      : b('obRestaurar','Restaurar','pri');
    return `<tr class="${o.situacao==='excluida'?'inativo':''}"><td><b>${esc(o.nome)}</b><br><small class="muted">${esc(o.cidade||'')}</small></td>
      <td><span class="tag ${cls}">${rot}</span>${o.excluidaEm?`<br><small class="muted">em ${fmtDataHora(o.excluidaEm)}</small>`:''}</td>
      <td class="n">${o.lancamentos}</td><td class="n">${o.funcionarios}</td><td>${o.ultimo?fmtData(o.ultimo):'—'}</td><td>${o.criadoEm?fmtData(String(o.criadoEm).slice(0,10)):''}</td><td>${acoes}</td></tr>`;
  }).join('') : '<tr><td colspan="7" class="muted">Nenhuma obra nesta situação.</td></tr>';
}
async function statusObra(id, acao){
  const o = OBRAS_TODAS.find(x=>x.id===id); if (!o) return;
  if (acao==='excluir') return abrirExclusao(id, o.nome, `${o.lancamentos} lançamento(s) e ${o.funcionarios} funcionário(s) cadastrados.`);
  const txt = {arquivar:`Arquivar "${o.nome}"? Ela sai da lista de todos os usuários, mas pode ser reativada aqui.`, reativar:`Reativar "${o.nome}"?`, restaurar:`Restaurar "${o.nome}"? A obra volta para a lista e a pasta sai da lixeira do Drive.`}[acao];
  if (!confirm(txt)) return;
  try { await api('obraStatus', {id, acao}); toast({arquivar:'Obra arquivada', reativar:'Obra reativada', restaurar:'Obra restaurada'}[acao]); await carregarObrasAdmin(); sincronizar(true); }
  catch(e){ toast(e instanceof ErroRede ? 'Sem conexão. O painel do administrador requer internet.' : e.message); }
}

async function salvarListas(){
  const lst = id => [...new Set($(id).value.split('\n').map(s=>s.trim()).filter(Boolean))];
  try {
    const r = await api('configSalvar', {formas:lst('c-formas'), unidades:lst('c-un'), subcats:lst('c-sub'), etapas:lst('c-etapas')});
    BASE.cfg = r.cfg; await kv.set('cache', BASE); reconstruir(); renderHome(); preencherListas(); toast('Listas salvas para todos os usuários');
  } catch(e){ toast(e instanceof ErroRede ? 'Sem conexão. Salvar listas requer internet.' : e.message); }
}
async function criarObraExemplo(){
  if (!confirm('Criar uma obra de exemplo com lançamentos fictícios? Ela será gravada no Drive e poderá ser arquivada depois.')) return;
  const obraId = uid();
  const comFin = BASE && (BASE.api||1) >= 3;
  await enfileirar('obra.salvar', {id:obraId, nome:'Obra Buriticupu (exemplo)', cidade:'Buriticupu/MA', prop:'Proprietário', eng:S.usuario.nome, ini:'2026-08-29',
    ...(comFin ? {fim:'2027-03-30', contrato:380000, area:600, orcamento:{mo:120000, material:150000, dia:25000, salario:24000}} : {})});
  const E = (categoria,data,descricao,unidade,qtd,vu,x={}) => enfileirar('lanc.salvar', {id:uid(), obraId, categoria, data, descricao, unidade, qtd, vu, forma:'PIX',
    fornecedor:'', doc:'', etapa:'', subcat:'', tipo:'', venc:'', mesRef:mesRefDe(data), obs:'', ...x});
  const ad = {tipo:'Adiantamento para custos', fornecedor:'Proprietário'};
  if (comFin){ await E('cliente','2026-08-25','Sinal do contrato','vb',1,76000,{tipo:'Sinal / entrada', fornecedor:'Contratante'});
    await E('cliente','2026-09-30','Medição 01','vb',1,95000,{tipo:'Medição', fornecedor:'Contratante', doc:'MED-01'}); }
  await E('enviado','2026-09-04','Pix recebido para custos','vb',1,1000,ad); await E('enviado','2026-09-07','Pix recebido para custos','vb',1,2000,ad);
  await E('enviado','2026-09-23','Pix recebido — reembolso','vb',1,2778,{tipo:'Reembolso recebido', fornecedor:'Proprietário'});
  await E('mo','2026-09-07','Início do serviço','vb',1,3500,{fornecedor:'Hamilton', etapa:'Serviços preliminares'});
  await E('mo','2026-09-21','Mão de obra – quinzena','vb',1,12270,{fornecedor:'Hamilton', etapa:'Alvenaria'});
  await E('material','2026-09-12','Tijolo cerâmico 8 furos','mil',23,1100,{etapa:'Alvenaria'});
  await E('material','2026-10-02','Cimento CP II 50 kg','saco',30,57,{etapa:'Estrutura'});
  await E('material','2026-10-02','Vergalhão CA-50 10 mm','barra',40,58.9,{etapa:'Estrutura'});
  await E('dia','2026-08-30','Almoço','vb',1,36,{subcat:'Alimentação'});
  await E('dia','2026-09-05','Abastecimento','L',63.5,6.08,{subcat:'Combustível', fornecedor:'POSTO NATUREZA'});
  await E('dia','2026-09-07','Hospedagem','dia',2,150,{subcat:'Hospedagem', fornecedor:'HOTEL VALE DO BURITI'});
  await E('dia','2026-09-18','Aluguel de martelete','dia',1,80,{subcat:'Equipamentos e locação'});
  await E('salario','2026-09-30','Salário do engenheiro','vb',1,3000,{fornecedor:'Proprietário'});
  await E('apagar','2026-10-21','Escavadeira para nivelamento do terreno','vb',1,6000,{venc:'2026-10-28', etapa:'Serviços preliminares'});
  toast('Obra de exemplo criada'); irObra(obraId); sincronizar();
}

/* =====================================================================
   INICIALIZAÇÃO
   ===================================================================== */
let pedidoAtualizar = false;
function registrarSW(){
  if (window.__DEMO__ || !('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
  navigator.serviceWorker.register('sw.js').then(reg=>{
    const avisar = w => { if (!w) return; w.addEventListener('statechange', ()=>{ if (w.state==='installed' && navigator.serviceWorker.controller){
      $('barraAtualizacao').hidden=false;
      $('btnAtualizar').onclick=()=>{ if (FILA.length && !confirm('Há operações aguardando envio. Elas continuam guardadas no aparelho. Atualizar agora?')) return; pedidoAtualizar = true; w.postMessage('ativar'); }; } }); };
    avisar(reg.installing); reg.addEventListener('updatefound', ()=>avisar(reg.installing));
    setInterval(()=>reg.update().catch(()=>{}), 3600e3);
  }).catch(()=>{});
  let recarregou = false;
  navigator.serviceWorker.addEventListener('controllerchange', ()=>{ if (pedidoAtualizar && !recarregou){ recarregou = true; location.reload(); } });
}

function ligarEventos(){
  document.querySelectorAll('.btnTema').forEach(b=>b.onclick=alternarTema);
  document.querySelectorAll('.sync').forEach(b=>b.onclick=()=>sincronizar(true));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', ()=>{ if (PREFS.tema==='auto' && S && obraAtualId()) renderResumo(); });
  window.addEventListener('hashchange', ()=>rotear());
  window.addEventListener('online', ()=>{ statusSync(); sincronizar(); });
  window.addEventListener('offline', statusSync);
  document.addEventListener('visibilitychange', ()=>{ if (document.visibilityState==='visible') sincronizar(); });
  setInterval(()=>sincronizar(), 60e3);
  // login
  $('s-ok').onclick = conectarServidor;
  $('lg-ok').onclick = entrar;
  $('lg-pass').addEventListener('keydown', e=>{ if (e.key==='Enter') entrar(); });
  $('lg-servidor').onclick = ()=>mostrarLogin('servidor');
  $('tr-ok').onclick = async ()=>{ if (await trocarSenha($('tr-atual').value, $('tr-nova').value, $('tr-conf').value, $('tr-erro'))) await iniciarSessao(); };
  $('tr-sair').onclick = ()=>mostrarLogin('login');
  // início
  $('btnSair').onclick = sair;
  $('n-abrir').onclick = ()=>cadastrarObra(true);
  $('n-salvar').onclick = ()=>cadastrarObra(false);
  $('btnUsuarios').onclick = ()=>{ location.hash = '#/admin'; };
  $('btnAdminVoltar').onclick = irInicio;
  $('b-ex').onclick = criarObraExemplo;
  $('b-exp').onclick = ()=>{ const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify({exportadoEm:new Date().toISOString(), por:S.usuario.login, ...BASE}, null, 1)], {type:'application/json'}));
    a.download = `copia-controle-obras-${hojeIso()}.json`; document.body.appendChild(a); a.click(); setTimeout(()=>{URL.revokeObjectURL(a.href); a.remove();}, 500); };
  $('c-salvar').onclick = salvarListas;
  document.querySelector('#cardAdmin details').addEventListener('toggle', e=>{ if (e.target.open) preencherListas(); });
  $('btnMinhaSenha').onclick = ()=>{ ['ms-atual','ms-nova','ms-conf'].forEach(i=>$(i).value=''); $('ms-erro').textContent=''; $('dlgMinhaSenha').showModal(); };
  $('ms-voltar').onclick = ()=>$('dlgMinhaSenha').close();
  $('ms-ok').onclick = async ()=>{ if (await trocarSenha($('ms-atual').value, $('ms-nova').value, $('ms-conf').value, $('ms-erro'))) $('dlgMinhaSenha').close(); };
  // obra
  $('btnInicio').onclick = irInicio;
  $('btnExcel').onclick = gerarExcel;
  document.querySelectorAll('#view-obra nav button').forEach(b=>b.onclick=()=>abrirTab(b.dataset.tab));
  $('f-cat').onchange = updateFormVisibility;
  $('f-forma').onchange = updateFormVisibility;
  $('f-un').onchange = ()=>{ updateFormVisibility(); if ($('f-un').value==='__outra') $('f-un-outra').focus(); };
  $('f-qtd').oninput = $('f-vu').oninput = calcTotal;
  $('f-data').onchange = ()=>{ $('f-mes').value = mesRefDe($('f-data').value); };
  $('f-comp').onchange = aoEscolherComprovante;
  $('f-compRem').onclick = limparComp;
  $('btnSalvar').onclick = ()=>salvar(false);
  $('btnSalvarOutro').onclick = ()=>salvar(true);
  $('btnCancelar').onclick = ()=>limparForm(false);
  $('btnLimparForm').onclick = ()=>limparForm(false);
  ['l-ini','l-fim','l-sub','l-forma','l-canc','l-sit','l-etapa'].forEach(id=>$(id).onchange=renderLista);
  $('l-txt').oninput = renderLista;
  $('l-agr').onchange = e=>{ PREFS.agrupamento=e.target.value; salvarPrefs(); renderLista(); };
  $('r-ini').onchange = $('r-fim').onchange = renderResumo;
  $('r-limpar').onclick = ()=>{ $('r-ini').value=''; $('r-fim').value=''; renderResumo(); };
  $('h-atualizar').onclick = carregarHistorico;
  $('pg-cat').onchange = ()=>{ $('pg-subWrap').hidden = $('pg-cat').value!=='dia'; };
  $('pg-ok').onclick = confirmarPago; $('pg-cancel').onclick = ()=>$('dlgPago').close();
  $('cn-ok').onclick = confirmarCancelamento; $('cn-voltar').onclick = ()=>$('dlgCancelar').close();
  $('cp-fechar').onclick = ()=>$('dlgComp').close();
  $('sp-ok').onclick = ()=>{ $('sp-senha').textContent=''; $('dlgSenha').close(); };
  document.querySelectorAll('.o-salvar').forEach(b=>b.onclick = salvarObra);
  ORC_CATS.forEach(k=>$('o-orc-'+k).oninput = somarOrcamento);
  $('f-desc').addEventListener('change', sugerirPorDescricao);
  $('f-vu').addEventListener('input', dicaPreco);
  $('o-arquivar').onclick = async ()=>{ const o=obraAtual(); const motivo = prompt(`Arquivar "${o.nome}"? Informe o motivo (ex.: obra concluída):`); if (!motivo) return;
    await enfileirar('obra.arquivar', {id:o.id, motivo}); toast('Obra arquivada'); irInicio(); sincronizar(); };
  $('p-add').onclick = async ()=>{
    const nome=$('p-nome').value.trim(), ini=$('p-ini').value, fim=$('p-fim').value;
    if(!nome||!ini||!fim) return alert('Preencha nome, início e fim do período.');
    if(fim<ini) return alert('A data final deve ser igual ou posterior à inicial.');
    const conflito = perObra().find(p=>!(fim<p.ini||ini>p.fim)); if(conflito && !confirm(`Este período se sobrepõe a "${conflito.nome}". Adicionar mesmo assim?`)) return;
    await enfileirar('periodo.salvar', {id:uid(), obraId:obraAtualId(), nome, ini, fim}); ['p-nome','p-ini','p-fim'].forEach(i=>$(i).value='');
    renderObra(); toast('Período adicionado'); sincronizar(); };
  // equipe
  $('eq-data').onchange = e=>trocarDiaChamada(e.target.value);
  $('eq-ant').onclick = ()=>{ const d = isoToDate(chamada.data); d.setDate(d.getDate()-1); trocarDiaChamada(dateToIso(d)); };
  $('eq-prox').onclick = ()=>{ const d = isoToDate(chamada.data); d.setDate(d.getDate()+1); trocarDiaChamada(dateToIso(d)); };
  $('eq-hoje').onclick = ()=>trocarDiaChamada(hojeIso());
  $('eq-salvar').onclick = salvarChamada; $('eq-todos').onclick = todosPresentes;
  ['fo-ini','fo-fim','fo-forma'].forEach(id=>$(id).onchange = renderFolha);
  $('fo-gerar').onclick = gerarFolha;
  $('mp-mes').onchange = renderMapa;
  $('fu-salvar').onclick = salvarFunc; $('fu-limpar').onclick = limparFunc;
  $('o-excluir').onclick = ()=>{ const o = obraAtual(); abrirExclusao(o.id, o.nome, `${lancObra().filter(l=>!l.cancelado).length} lançamento(s) e ${funcObra(true).length} funcionário(s) cadastrados.`); };
  $('ex-conf').oninput = ()=>{ $('ex-ok').disabled = !excluindo || $('ex-conf').value.trim().toLowerCase() !== excluindo.nome.trim().toLowerCase(); };
  $('ex-ok').onclick = confirmarExclusao; $('ex-voltar').onclick = ()=>{ excluindo = null; $('dlgExcluir').close(); };
  // admin
  $('ob-filtro').onchange = renderObrasAdmin; $('ob-atualizar').onclick = carregarObrasAdmin;
  $('u-salvar').onclick = salvarUsuario; $('u-novo').onclick = novoUsuario;
  $('u-perfil').onchange = ()=>{ $('u-obrasWrap').hidden = $('u-perfil').value==='admin'; };
  // cliques delegados
  document.body.addEventListener('click', async e=>{
    if (e.target.id==='btnLimparRej'){ REJ=[]; await kv.set('rejeitados', REJ); renderHome(); return; }
    const op = e.target.closest('[data-open]'); if (op) return irObra(op.dataset.open);
    const it = e.target.closest('[data-irtab]'); if (it){ abrirTab(it.dataset.irtab); window.scrollTo({top:0,behavior:'smooth'}); return; }
    const pk = e.target.closest('[data-pick]'); if (pk){ $('f-cat').value = pk.dataset.pick; updateFormVisibility(); dicaPreco(); return; }
    const pr = e.target.closest('[data-pres]'); if (pr){ if (!pr.disabled) marcar(pr.dataset.func, +pr.dataset.pres); return; }
    const fs = e.target.closest('[data-folha]'); if (fs){ folhaSel[fs.dataset.folha] = fs.checked; renderFolha(); return; }
    const am = e.target.closest('[data-adm]'); if (am){ abrirAbaAdmin(am.dataset.adm); return; }
    const ol = e.target.closest('[data-olho]'); if (ol){ const i = $(ol.dataset.olho); const ver = i.type==='password'; i.type = ver ? 'text' : 'password'; ol.setAttribute('aria-pressed', ver); ol.title = ver ? 'Ocultar senha' : 'Mostrar senha'; return; }
    const b = e.target.closest('[data-act]'); if (b) return acao(b.dataset.act, b.dataset.id);
    const c = e.target.closest('[data-cat]'); if (c){ listaCat=c.dataset.cat; renderLista(); return; }
    const s = e.target.closest('th[data-sort]'); if (s){ sortD = sortK===s.dataset.sort ? -sortD : 1; sortK=s.dataset.sort; renderLista(); }
  });
}

async function init(){
  $('versaoApp').textContent = 'Controle de Obras v' + VERSAO_APP;
  lerPrefs(); aplicarTema(); ligarEventos(); registrarSW();
  try { await kv.abrir(); } catch(e){
    if (!window.__DEMO__){ document.body.innerHTML = '<p style="padding:20px">Este navegador bloqueou o armazenamento local (modo anônimo?). Abra em uma janela normal.</p>'; return; }
    const m = new Map(); Object.assign(kv, {get:async k=>m.get(k), set:async (k,v)=>{ m.set(k,v); }, del:async k=>{ m.delete(k); }});
  }
  if (window.__DEMO__){ await window.__DEMO__.iniciar(); return; }
  CONF = (await kv.get('conf')) || {};
  const qp = new URLSearchParams(location.search).get('api');
  if (qp && /^https:\/\/script\.google(usercontent)?\.com\//.test(qp) || qp && /^http:\/\/localhost(:\d+)?\//.test(qp)){ CONF.api = qp; await kv.set('conf', CONF); }
  if (qp) history.replaceState(null, '', location.pathname + location.hash);
  SESSAO = (await kv.get('sessao')) || null;
  FILA = (await kv.get('fila')) || [];
  if (!CONF.api) return mostrarLogin('servidor');
  if (!SESSAO || !SESSAO.token) return mostrarLogin('login', FILA.length ? `Há ${FILA.length} operação(ões) guardada(s) neste aparelho; elas serão enviadas após entrar.` : '');
  if (SESSAO.usuario.trocarSenha) return mostrarLogin('troca');
  await iniciarSessao();
}
document.addEventListener('DOMContentLoaded', init);
