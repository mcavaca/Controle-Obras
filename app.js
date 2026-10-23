/* =========================================================================
   CONTROLE DE OBRAS — APLICATIVO (PWA)
   • Dados oficiais ficam no Google Drive (servidor Apps Script).
   • O aparelho guarda uma cópia (IndexedDB) e uma FILA de operações;
     sem internet, tudo é lançado normalmente e enviado depois.
   ========================================================================= */
'use strict';
const VERSAO_APP = '1.2.0 · edição tablet';
const FORMA_PEND = 'A pagar';   // forma de pagamento que deixa o item pendente até a baixa

/* =====================================================================
   NÚCLEO — regras de negócio (iguais às do servidor)
   ===================================================================== */
const CATS = {
  enviado:  {nome:'Valor enviado',    cor:'#2e7d32'},
  mo:       {nome:'Mão de Obra',      cor:'#1565c0'},
  material: {nome:'Material',         cor:'#7b1fa2'},
  dia:      {nome:'Custos dia a dia', cor:'#b84300'},
  salario:  {nome:'Salário',          cor:'#00838f'},
  apagar:   {nome:'Valor a pagar',    cor:'#c62828'}
};
const CAT_ORDER = ['enviado','mo','material','dia','salario','apagar'];
const CAT_TOTAL = ['mo','material','dia','salario','apagar'];
const CAT_PROPRIETARIO = ['enviado','mo','material','salario','apagar'];
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
  if (s.includes(',')) s = s.replace(/\./g,'').replace(',','.');
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

function totais(list){
  const t = {enviado:0,mo:0,material:0,dia:0,salario:0,apagar:0,adiant:0,reembRec:0,pend:0,diaPend:0,qPend:0};
  let prox = null;
  for (const l of list){
    if (l.cancelado) continue;
    t[l.categoria] = (t[l.categoria]||0) + (+l.total||0);
    if (l.status==='Pendente'){
      t.pend += +l.total||0; t.qPend++;
      if (l.categoria==='dia') t.diaPend += +l.total||0;
      if (l.venc && (!prox || l.venc < prox.venc)) prox = l;
    }
    if (l.categoria==='enviado'){ if (l.tipo==='Reembolso recebido') t.reembRec += +l.total||0; else t.adiant += +l.total||0; }
  }
  for (const k in t) if (k!=='qPend') t[k] = round2(t[k]);
  t.proxVenc = prox ? prox.venc : '';
  t.reembolso = round2(t.dia - t.diaPend - t.enviado);   // custos dia a dia ainda "A pagar" não entram no reembolso
  t.total = round2(CAT_TOTAL.reduce((a,k)=>a+t[k],0));
  return t;
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
  por:l=>nomeUsuario(l.criadoPor), comp:l=>l.comprovanteId?'Sim':'' };
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
function construirWorkbook(obra, L, agrupamento, periodos){
  const wb = XLSX.utils.book_new();
  const gerado = new Date().toLocaleString('pt-BR');
  const info = `Obra: ${obra.nome}${obra.cidade?' — '+obra.cidade:''}  |  Gerado em ${gerado} por ${S.usuario.nome}`;
  const de = k => L.filter(l=>l.categoria===k).sort(porData);
  const t = totais(L);
  const comuns = [col('Forma de pagamento','forma',14),col('Qtd.','qtd',7),col('Unid.','un',7),col('Valor unitário (R$)','vu',15),col('Valor total (R$)','total',16),col('Mês ref.','mes',9),col('Comprovante','comp',12),col('Lançado por','por',18),col('Observações','obs',30),col('Situação','status',10),col('Vencimento','venc',11)];
  const env = abaSimples('Valor enviado','VALOR ENVIADO PELO PROPRIETÁRIO',info,[col('Data','data',11),col('Nº documento','doc',14),col('Tipo','tipo',24),col('Origem do recurso','forn',26),col('Descrição','desc',34),...comuns], de('enviado'));
  const mo  = abaSimples('Mão de Obra','MÃO DE OBRA',info,[col('Data','data',11),col('Nº documento','doc',14),col('Beneficiário','forn',24),col('Descrição','desc',34),col('Etapa da obra','etapa',16),...comuns], de('mo'));
  const mat = abaSimples('Material','MATERIAL',info,[col('Data','data',11),col('Nº NF / Recibo','doc',14),col('Fornecedor','forn',24),col('Material','desc',34),col('Etapa da obra','etapa',16),...comuns], de('material'));
  const dia = abaCustos('Custos dia a dia','CUSTOS DIA A DIA',info, de('dia'), agrupamento||'semana', periodos);
  const sal = abaSimples('Salário','SALÁRIO DO ENGENHEIRO',info,[col('Data','data',11),col('Nº documento','doc',14),col('Origem','forn',22),col('Descrição','desc',34),...comuns], de('salario'));
  const pag = abaSimples('A pagar','PREVISÃO DE PAGAMENTOS (A PAGAR)',info,[col('Data','data',11),col('Vencimento','venc',11),col('Fornecedor / Beneficiário','forn',26),col('Descrição','desc',40),col('Etapa da obra','etapa',16),
    col('Qtd.','qtd',7),col('Unid.','un',7),col('Valor unitário (R$)','vu',15),col('Valor total (R$)','total',16),col('Status','status',10),col('Lançado por','por',18),col('Observações','obs',30)],
    de('apagar').sort((a,b)=>(a.venc||'').localeCompare(b.venc||'')));
  // ATENÇÃO: as colunas C (Tipo) e J (Valor total) da aba "Valor enviado" são usadas abaixo
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
  const linhas = [['Valor enviado', env.ref, t.enviado, false], ['Valor de Mão de Obra', mo.ref, t.mo, true], ['Valor de Material', mat.ref, t.material, true],
    ['Custos dia a dia', dia.ref, t.dia, true], ['Valor de Salário', sal.ref, t.salario, true], ['Valor a pagar', pag.ref, t.apagar, true]];
  const IM = [[cT(`CONTROLE DE GASTOS — ${obra.nome.toUpperCase()}`,XS.title)],
    [cT('Cidade/UF',XS.lbl), cT(obra.cidade||'')], [cT('Proprietário',XS.lbl), cT(obra.prop||'')],
    [cT('Engenheiro responsável',XS.lbl), cT(obra.eng||'')], [cT('Início da obra',XS.lbl), cD(obra.ini||'')],
    [cT('Gerado em',XS.lbl), cT(`${gerado} — ${S.usuario.nome}`)], [],
    [cT('Categoria',XS.head), cT('Valor (R$)',XS.head), cT('% do valor total',XS.head)]];
  linhas.forEach(([n,ref,v,entra])=>{ const r = IM.length+1;
    IM.push([cT(n,XS.lbl), cF(ref, v), entra ? {t:'n', f:`IF($B$16=0,0,B${r}/$B$16)`, v:t.total? v/t.total:0, z:'0.0%', s:XS.pct} : cT('não compõe o total',XS.info)]); });
  IM.push([cT('Valor de reembolso',XS.lbl), cF("'Reembolso'!B9", t.reembolso), cFs("'Reembolso'!B10", interpretaReemb(t.reembolso), XS.txt)]);
  IM.push([cT('VALOR TOTAL',XS.grandLbl), cF('B10+B11+B12+B13+B14', t.total, XS.grand), cT('',XS.grandLbl)]);
  IM.push([], [cT('Valor total = Mão de Obra + Material + Custos dia a dia + Salário + Valor a pagar.',XS.info)],
    [cT('Valor de reembolso = Custos dia a dia já pagos − Valor enviado. Lançamentos cancelados não entram no relatório.',XS.info)],
    [], [cT('Pendente de pagamento',XS.lbl), cM(t.pend), cT(t.qPend ? `${t.qPend} item(ns) · próximo vencimento ${fmtData(t.proxVenc)}` : 'nenhum',XS.txt)]);
  const inicio = montarAba(IM,[30,22,34],[{s:{r:0,c:0},e:{r:0,c:2}}]);
  [['Início',inicio],['Valor enviado',env.ws],['Mão de Obra',mo.ws],['Material',mat.ws],['Custos dia a dia',dia.ws],['Salário',sal.ws],['A pagar',pag.ws],['Reembolso',reemb]]
    .forEach(([n,ws])=>XLSX.utils.book_append_sheet(wb, ws, n));
  return wb;
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
  S.usuario = SESSAO.usuario;
  for (const op of FILA) aplicarLocal(op);
}

function aplicarLocal(op){
  const d = op.dados || {};
  const achar = (arr, id) => arr.find(x=>x.id===id);
  switch (op.tipo){
    case 'obra.salvar': {
      const campos = {nome:d.nome, cidade:d.cidade, prop:d.prop, eng:d.eng, ini:d.ini};
      const o = achar(S.obras, d.id);
      if (o) Object.assign(o, campos, {_pend:true}); else S.obras.push({id:d.id, ...campos, _pend:true});
      break; }
    case 'obra.arquivar': S.obras = S.obras.filter(o=>o.id!==d.id); break;
    case 'lanc.salvar': {
      const rec = {...d, vu:round2(d.vu), total:round2(d.qtd*round2(d.vu)), status:(d.categoria==='apagar'||d.forma===FORMA_PEND)?'Pendente':'Pago', _pend:true};
      if (d.categoria!=='dia') rec.subcat=''; if (d.categoria!=='enviado') rec.tipo=''; if (rec.status!=='Pendente') rec.venc='';
      const l = achar(S.lanc, d.id);
      if (l) Object.assign(l, rec);
      else S.lanc.push({...rec, comprovanteId:'', criadoPor:S.usuario.id, criadoEm:new Date(op.criadoEm).toISOString(), cancelado:false, motivoCancel:''});
      break; }
    case 'lanc.cancelar': { const l = achar(S.lanc, d.id); if (l) Object.assign(l, {cancelado:true, motivoCancel:d.motivo, _pend:true}); break; }
    case 'lanc.pagar': { const l = achar(S.lanc, d.id);
      if (l && l.categoria!=='apagar' && l.forma===FORMA_PEND && l.status==='Pendente'){
        const nota = `Pago em ${fmtData(d.data)} via ${d.forma} (previsto para ${fmtData(l.venc)})`;
        Object.assign(l, {forma:d.forma, status:'Pago', obs:l.obs?l.obs+' | '+nota:nota, _pend:true}); break; }
      if (l && l.categoria==='apagar'){
      const nota = `Previsto em "A pagar" (venc. ${fmtData(l.venc)})`;
      Object.assign(l, {categoria:d.categoria, data:d.data, forma:d.forma, status:'Pago', subcat:d.categoria==='dia'?d.subcat:'', mesRef:mesRefDe(d.data), obs:l.obs?l.obs+' | '+nota:nota, venc:'', _pend:true}); } break; }
    case 'periodo.salvar': { const p = achar(S.periodos, d.id); if (p) Object.assign(p, d); else S.periodos.push({...d}); break; }
    case 'periodo.excluir': S.periodos = S.periodos.filter(p=>p.id!==d.id); break;
    case 'comprovante.enviar': { const l = achar(S.lanc, d.lancId); if (l){ l._compPend = op.opId; l._pend = true; } break; }
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
    BASE = {api:r.api||1, usuario:r.usuario, cfg:r.cfg, obras:r.obras, lanc:r.lanc, periodos:r.periodos, nomes:r.nomes||{}};
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
    'periodo.salvar':'Período', 'periodo.excluir':'Excluir período', 'comprovante.enviar':'Comprovante', 'relatorio.salvar':'Relatório no Drive'};
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

/* ---------- permissões (espelham o servidor) ---------- */
const perfil = () => S.usuario.perfil;
const ehAdmin = () => perfil()==='admin';
const ehProp = () => perfil()==='proprietario';
const catsPermitidas = () => ehProp() ? CAT_PROPRIETARIO : CAT_ORDER;
const podePagar = l => ehPendente(l) && !(ehProp() && l.categoria==='dia');
const podeEditar = l => !l.cancelado && (ehAdmin() || l.criadoPor===S.usuario.id);

/* ---------- tema ---------- */
function aplicarTema(){
  const t = PREFS.tema||'auto', r = document.documentElement;
  if (t==='claro') r.dataset.theme='light'; else if (t==='escuro') r.dataset.theme='dark'; else delete r.dataset.theme;
  document.querySelectorAll('.btnTema').forEach(b=>b.textContent = t==='claro' ? '☀️ Claro' : t==='escuro' ? '🌙 Escuro' : '🖥️ Auto');
  document.querySelectorAll('.btnTema').forEach(b=>b.title='Tema: toque para alternar entre claro, escuro e automático');
}
function alternarTema(){
  const ord = ['claro','escuro','auto'];
  PREFS.tema = ord[(ord.indexOf(PREFS.tema||'auto')+1)%3]; salvarPrefs(); aplicarTema();
  if (obraAtualId()) renderResumo();
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
    if (viewAnterior!=='admin') carregarUsuarios();
    viewAnterior = 'admin'; return;
  }
  if (h==='#/admin') history.replaceState(null,'','#/');
  if (id){
    mostrarView('obra');
    if (!soAtualizar || obraAnterior!==id){
      listaCat='todas'; ['r-ini','r-fim','l-ini','l-fim','l-txt'].forEach(x=>$(x).value=''); $('histBody').innerHTML='';
      renderListas(); limparForm(false); abrirTab('lancar'); window.scrollTo(0,0); preencherDadosObra();
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
    const pend = L.filter(ehPendente);
    const lblR = t.reembolso>0.004 ? 'A reembolsar' : t.reembolso<-0.004 ? 'Saldo em caixa' : 'Reembolso';
    const sub = [o.cidade, o.prop && 'Prop.: '+o.prop, o.ini && 'Início: '+fmtData(o.ini)].filter(Boolean).map(esc).join(' · ');
    return `<div class="obra-card">
      <div><h3>${esc(o.nome)} ${o._pend?'<span class="tag">⏳ não enviada</span>':''}</h3><div class="muted">${sub || 'Sem dados complementares'}</div></div>
      <div class="oc-nums">
        <div><span>Valor total</span><b>${fmtBRL(t.total)}</b></div>
        <div><span>${lblR}</span><b>${fmtBRL(Math.abs(t.reembolso))}</b></div>
        <div><span>Lançamentos</span><b>${L.length}</b></div>
        <div><span>Último lançamento</span><b>${ult ? fmtData(ult) : '—'}</b></div>
      </div>
      ${pend.length ? `<div class="aviso">⏰ ${pend.length} pagamento(s) pendente(s): ${fmtBRL(t.pend)}${t.proxVenc?` · próximo ${fmtData(t.proxVenc).slice(0,5)}`:''}</div>` : ''}
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
  renderListas(); renderMini(); renderResumo(); renderLista(); renderDadosObra();
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
  updateFormVisibility();
}

/* ---------- formulário ---------- */
function updateFormVisibility(){
  const cat = $('f-cat').value;
  document.querySelectorAll('#tab-lancar [data-show]').forEach(el=>{ el.hidden = !el.dataset.show.split(',').includes(cat); });
  const optPend = [...$('f-forma').options].find(o=>o.value===FORMA_PEND);
  if (optPend){ optPend.disabled = optPend.hidden = cat==='enviado'; if (cat==='enviado' && $('f-forma').value===FORMA_PEND) $('f-forma').value = S.cfg.formas[0]; }
  const aPrazo = $('f-forma').value===FORMA_PEND && cat!=='apagar';
  $('f-venc').closest('.fld').hidden = !(cat==='apagar' || aPrazo);
  document.querySelector('label[for=f-venc]').textContent = aPrazo ? 'Data prevista de pagamento' : 'Vencimento';
  $('lbl-forn').textContent = cat==='enviado' ? 'Origem do recurso (quem enviou)' : cat==='mo' ? 'Beneficiário' : cat==='salario' ? 'Origem' : 'Fornecedor / Beneficiário';
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
  $('f-erro').textContent = ''; updateFormVisibility();
}
function preencherForm(l){
  $('f-desc').value=l.descricao; $('f-data').value=l.data;
  $('f-cat').value = catsPermitidas().includes(l.categoria) ? l.categoria : catsPermitidas()[0]; $('f-forma').value=l.forma;
  $('f-subcat').value=l.subcat||''; $('f-tipo').value=l.tipo||'Adiantamento para custos'; $('f-venc').value=l.venc||'';
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
    subcat: cat==='dia' ? $('f-subcat').value : '', tipo: cat==='enviado' ? $('f-tipo').value : '', venc: pendente ? $('f-venc').value : '',
    fornecedor:$('f-forn').value.trim(), doc:$('f-doc').value.trim(), etapa:$('f-etapa').value.trim(), mesRef:$('f-mes').value || mesRefDe(data), obs:$('f-obs').value.trim() };
}
function possivelDuplicado(o, id){
  const n = s => (s||'').trim().toLowerCase(), tot = round2(o.qtd*o.vu);
  return ativos().find(l => l.id!==id && l.data===o.data && l.categoria===o.categoria && round2(l.total)===tot &&
    (n(l.descricao)===n(o.descricao) || (o.fornecedor && n(l.fornecedor)===n(o.fornecedor))));
}
async function salvar(continuar){
  const o = coletarForm(); if (!o) return;
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
  return CAT_ORDER.map(k=>{
    let sub = ''; if (k==='enviado') sub = t.reembRec ? `inclui ${fmtBRL(t.reembRec)} de reembolso` : 'não compõe o total';
    return kpiHTML(CATS[k].nome, t[k], CATS[k].cor, sub);
  }).join('') + kpiHTML('Valor de reembolso', Math.abs(t.reembolso), '#607d8b', interpretaReemb(t.reembolso)) + kpiPend(t) +
  kpiHTML('VALOR TOTAL', t.total, '#1f4e78', 'MO + Material + Dia a dia + Salário + A pagar', 'total');
}
function kpiPend(t){
  return kpiHTML('Pendente de pagamento', t.pend, '#8a6d00', t.qPend ? `${t.qPend} item(ns) · próximo venc. ${fmtData(t.proxVenc)}` : 'nada a pagar');
}
function renderMini(){
  const L = ativos(), t = totais(L), pend = lancObra().filter(l=>l._pend).length;
  $('miniKpis').innerHTML = kpiHTML('Custos dia a dia', t.dia, CATS.dia.cor) +
    kpiHTML('Valor de reembolso', Math.abs(t.reembolso), '#607d8b', interpretaReemb(t.reembolso)) + kpiPend(t).replace('style="', 'style="grid-column:1/-1;') +
    kpiHTML('VALOR TOTAL', t.total, '#1f4e78', `${L.length} lançamento(s)${pend?` · ${pend} a enviar`:''}`, 'total');
  const ult = lancObra().slice().sort((a,b)=>String(b.criadoEm||'').localeCompare(String(a.criadoEm||''))).slice(0,6);
  $('ultimos').innerHTML = ult.length ? ult.map(l=>`<tr class="${l.cancelado?'cancel':''}"><td title="${fmtData(l.data)}">${fmtData(l.data).slice(0,5)}</td><td>${badge(l.categoria)}</td><td>${esc(l.descricao)} ${l._pend?'<span class="tag">⏳</span>':''}</td><td class="n">${fmtBRL(l.total)}</td>
    <td>${podeEditar(l)?`<button class="btn sm" data-act="edit" data-id="${l.id}" type="button" title="Editar" aria-label="Editar">✎</button>`:''}</td></tr>`).join('')
    : `<tr><td class="muted">Nenhum lançamento nesta obra ainda.</td></tr>`;
}

/* ---------- resumo ---------- */
function renderResumo(){
  if (!obraAtualId()) return;
  const ini=$('r-ini').value, fim=$('r-fim').value;
  const L = ativos().filter(l => (!ini || l.data>=ini) && (!fim || l.data<=fim)), t = totais(L);
  $('kpis').innerHTML = kpisFull(t);
  const hoje = hojeIso();
  const pend = ativos().filter(ehPendente).sort((a,b)=>(a.venc||'').localeCompare(b.venc||''));
  $('vencs').innerHTML = pend.length ? pend.map(l=>`<tr><td class="${l.venc<hoje?'venc-atraso':''}">${fmtData(l.venc)}${l.venc<hoje?' (vencido)':''}</td><td class="wrap">${badge(l.categoria)} ${esc(l.descricao)}</td>
    <td>${esc(l.fornecedor)}</td><td class="n">${fmtBRL(l.total)}</td><td>${podePagar(l)?`<button class="btn sm pri" data-act="pagar" data-id="${l.id}" type="button">✓ Pago</button>`:''}</td></tr>`).join('')
    : `<tr><td colspan="5" class="muted">Nenhum pagamento previsto.</td></tr>`;
  if (typeof Chart === 'undefined' || !$('tab-resumo').classList.contains('on')) return;
  const css = getComputedStyle(document.documentElement);
  const cTxt = css.getPropertyValue('--txt').trim(), cBd = css.getPropertyValue('--bd').trim(), cCard = css.getPropertyValue('--card').trim();
  Chart.defaults.color = cTxt; Chart.defaults.borderColor = cBd;
  const comp = CAT_TOTAL.filter(k=>t[k]>0);
  $('compVazio').hidden = comp.length>0; $('chComp').parentElement.hidden = !comp.length;
  charts.comp && charts.comp.destroy();
  charts.comp = new Chart($('chComp'), {type:'doughnut',
    data:{labels:comp.map(k=>CATS[k].nome), datasets:[{data:comp.map(k=>t[k]), backgroundColor:comp.map(k=>CATS[k].cor), borderColor:cCard, borderWidth:2}]},
    options:{animation:false, maintainAspectRatio:false, plugins:{legend:{position:'bottom', labels:{color:cTxt}}, tooltip:{callbacks:{label:c=>`${c.label}: ${fmtBRL(c.raw)} (${(c.raw/t.total*100).toFixed(1)}%)`}}}}});
  const subs = {}; L.filter(l=>l.categoria==='dia').forEach(l=>{ const s=l.subcat||'Outros'; subs[s]=(subs[s]||0)+l.total; });
  const sk = Object.keys(subs).sort((a,b)=>subs[b]-subs[a]);
  $('subVazio').hidden = sk.length>0; $('chSub').parentElement.hidden = !sk.length;
  charts.sub && charts.sub.destroy();
  charts.sub = new Chart($('chSub'), {type:'bar',
    data:{labels:sk, datasets:[{data:sk.map(k=>round2(subs[k])), backgroundColor:CATS.dia.cor, borderRadius:4}]},
    options:{animation:false, indexAxis:'y', maintainAspectRatio:false, plugins:{legend:{display:false}, tooltip:{callbacks:{label:c=>fmtBRL(c.raw)}}},
      scales:{x:{ticks:{color:cTxt, callback:v=>'R$ '+(+v).toLocaleString('pt-BR')}, grid:{color:cBd}}, y:{ticks:{color:cTxt}, grid:{color:cBd}}}}});
}

/* ---------- lista ---------- */
const COLS_LISTA = [
  {k:'data',h:'Data',f:l=>fmtData(l.data)}, {k:'categoria',h:'Categoria',f:l=>badge(l.categoria)},
  {k:'descricao',h:'Descrição',f:l=>`${esc(l.descricao)}${l._pend?' <span class="tag" title="Ainda não enviado ao Drive">⏳</span>':''}${l.cancelado?` <span class="tag" title="${esc(l.motivoCancel)}">cancelado</span>`:''}`},
  {k:'fornecedor',h:'Fornecedor',f:l=>esc(l.fornecedor)},
  {k:'subcat',h:'Subcat./Tipo',f:l=>esc(l.subcat||l.tipo||'')}, {k:'forma',h:'Forma',f:l=>esc(l.forma)},
  {k:'qtd',h:'Qtd.',n:1,f:l=>fmtNum(l.qtd)}, {k:'unidade',h:'Un.',f:l=>esc(l.unidade)},
  {k:'vu',h:'V. unit.',n:1,f:l=>fmtBRL(l.vu)}, {k:'total',h:'Total',n:1,f:l=>`<b>${fmtBRL(l.total)}</b>`},
  {k:'venc',h:'Venc./Status',f:l=>ehPendente(l)?`<span class="${l.venc<hojeIso()?'venc-atraso':''}">${fmtData(l.venc)}</span> · <span class="tag">Pendente</span>`:esc(l.status)},
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
  let L = lancObra().filter(l => (canc || !l.cancelado) && (listaCat==='todas'||l.categoria===listaCat) && (!ini||l.data>=ini) && (!fim||l.data<=fim) &&
    (!sub||l.subcat===sub) && (!forma||l.forma===forma) && (!q || [l.descricao,l.fornecedor,l.doc,l.obs,l.etapa].join(' ').toLowerCase().includes(q)));
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
        `<tr class="sub"><td colspan="9" class="n">Subtotal do período</td><td class="n">${fmtBRL(st)}</td><td colspan="3"></td></tr>`;
    }
  } else html = L.map(linha).join('');
  $('listaBody').innerHTML = html;
  $('listaFoot').innerHTML = `<tr><td colspan="9" class="n">${L.filter(l=>!l.cancelado).length} lançamento(s) — Total filtrado</td><td class="n">${fmtBRL(somaAt(L))}</td><td colspan="3"></td></tr>`;
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
function preencherDadosObra(){
  const o = obraAtual(); if (!o) return;
  $('o-nome').value=o.nome; $('o-cidade').value=o.cidade||''; $('o-prop').value=o.prop||''; $('o-eng').value=o.eng||''; $('o-ini').value=o.ini||'';
}
function renderDadosObra(){
  const pode = !ehProp();
  ['o-nome','o-cidade','o-prop','o-eng','o-ini'].forEach(i=>$(i).disabled=!pode); $('o-salvar').hidden = !pode;
  $('perForm').hidden = !pode; $('cardArquivar').hidden = !ehAdmin();
  const P = perObra();
  $('perList').innerHTML = P.length ? P.map(p=>`<tr><td><b>${esc(p.nome)}</b></td><td>${fmtData(p.ini)} – ${fmtData(p.fim)}</td>
    <td>${pode?`<button class="btn sm danger" data-act="delper" data-id="${p.id}" type="button">Remover</button>`:''}</td></tr>`).join('')
    : `<tr><td class="muted">Nenhum período cadastrado.</td></tr>`;
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
}
async function gerarExcel(){
  if (typeof XLSX === 'undefined'){ alert('Componente do Excel não carregou. Recarregue a página.'); return; }
  const o = obraAtual();
  const wb = construirWorkbook(o, ativos(), PREFS.agrupamento||'semana', perObra());
  const d = hojeIso().split('-').reverse().join('-');
  const nome = `Controle de Gastos - ${o.nome.replace(/[\\/:*?"<>|]/g,'-')} - ${d}.xlsx`;
  XLSX.writeFile(wb, nome);
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
  await enfileirar('obra.salvar', {id:obraId, nome:'Obra Buriticupu (exemplo)', cidade:'Buriticupu/MA', prop:'Proprietário', eng:S.usuario.nome, ini:'2026-08-29'});
  const E = (categoria,data,descricao,unidade,qtd,vu,x={}) => enfileirar('lanc.salvar', {id:uid(), obraId, categoria, data, descricao, unidade, qtd, vu, forma:'PIX',
    fornecedor:'', doc:'', etapa:'', subcat:'', tipo:'', venc:'', mesRef:mesRefDe(data), obs:'', ...x});
  const ad = {tipo:'Adiantamento para custos', fornecedor:'Proprietário'};
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
  if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
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
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', ()=>{ if ((PREFS.tema||'auto')==='auto' && S) renderResumo(); });
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
  ['l-ini','l-fim','l-sub','l-forma','l-canc'].forEach(id=>$(id).onchange=renderLista);
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
  $('o-salvar').onclick = async ()=>{ const o=obraAtual(); if(!$('o-nome').value.trim()) return alert('Informe o nome da obra.');
    await enfileirar('obra.salvar', {id:o.id, nome:$('o-nome').value.trim(), cidade:$('o-cidade').value.trim(), prop:$('o-prop').value.trim(), eng:$('o-eng').value.trim(), ini:$('o-ini').value});
    renderObra(); toast('Dados da obra salvos'); sincronizar(); };
  $('o-arquivar').onclick = async ()=>{ const o=obraAtual(); const motivo = prompt(`Arquivar "${o.nome}"? Informe o motivo (ex.: obra concluída):`); if (!motivo) return;
    await enfileirar('obra.arquivar', {id:o.id, motivo}); toast('Obra arquivada'); irInicio(); sincronizar(); };
  $('p-add').onclick = async ()=>{
    const nome=$('p-nome').value.trim(), ini=$('p-ini').value, fim=$('p-fim').value;
    if(!nome||!ini||!fim) return alert('Preencha nome, início e fim do período.');
    if(fim<ini) return alert('A data final deve ser igual ou posterior à inicial.');
    const conflito = perObra().find(p=>!(fim<p.ini||ini>p.fim)); if(conflito && !confirm(`Este período se sobrepõe a "${conflito.nome}". Adicionar mesmo assim?`)) return;
    await enfileirar('periodo.salvar', {id:uid(), obraId:obraAtualId(), nome, ini, fim}); ['p-nome','p-ini','p-fim'].forEach(i=>$(i).value='');
    renderObra(); toast('Período adicionado'); sincronizar(); };
  // admin
  $('u-salvar').onclick = salvarUsuario; $('u-novo').onclick = novoUsuario;
  $('u-perfil').onchange = ()=>{ $('u-obrasWrap').hidden = $('u-perfil').value==='admin'; };
  // cliques delegados
  document.body.addEventListener('click', async e=>{
    if (e.target.id==='btnLimparRej'){ REJ=[]; await kv.set('rejeitados', REJ); renderHome(); return; }
    const op = e.target.closest('[data-open]'); if (op) return irObra(op.dataset.open);
    const b = e.target.closest('[data-act]'); if (b) return acao(b.dataset.act, b.dataset.id);
    const c = e.target.closest('[data-cat]'); if (c){ listaCat=c.dataset.cat; renderLista(); return; }
    const s = e.target.closest('th[data-sort]'); if (s){ sortD = sortK===s.dataset.sort ? -sortD : 1; sortK=s.dataset.sort; renderLista(); }
  });
}

async function init(){
  $('versaoApp').textContent = 'Controle de Obras v' + VERSAO_APP;
  lerPrefs(); aplicarTema(); ligarEventos(); registrarSW();
  try { await kv.abrir(); } catch(e){ document.body.innerHTML = '<p style="padding:20px">Este navegador bloqueou o armazenamento local (modo anônimo?). Abra em uma janela normal.</p>'; return; }
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
