(function(){
'use strict';
document.documentElement.lang='pt-BR';

/* ---------- Utilitários ---------- */
var $=function(s){return document.querySelector(s);};
var fmtBRL=new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'});
function brl(c){return fmtBRL.format(c/100);}
function pad(n){return String(n).padStart(2,'0');}
function hoje(){var d=new Date();return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());}
function mesLabel(k){var p=k.split('-').map(Number);var s=new Intl.DateTimeFormat('pt-BR',{month:'long',year:'numeric'}).format(new Date(p[0],p[1]-1,1));return s.charAt(0).toUpperCase()+s.slice(1);}
function addMes(k,delta){var p=k.split('-').map(Number),y=p[0],m=p[1]+delta;while(m<1){m+=12;y--;}while(m>12){m-=12;y++;}return y+'-'+pad(m);}
function dataCurta(s){var p=s.split('-');return p[2]+'/'+p[1];}
function dataValida(s){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(s))return false;
  var p=s.split('-').map(Number),dt=new Date(p[0],p[1]-1,p[2]);
  return dt.getFullYear()===p[0]&&dt.getMonth()===p[1]-1&&dt.getDate()===p[2]&&p[0]>=1900&&p[0]<=2200;
}
function diasNoMes(y,m){return new Date(y,m,0).getDate();}
/* Dia de um mês 'AAAA-MM', caindo no último dia quando o mês é mais curto */
function dataComDia(k,dia){var p=k.split('-').map(Number);return k+'-'+pad(Math.min(dia,diasNoMes(p[0],p[1])));}
/* Mesma data, 'n' meses depois (dia 31 vira o último dia do mês) */
function dataNoMes(data,n){return dataComDia(addMes(data.slice(0,7),n),Number(data.slice(8,10)));}
function norm(s){return String(s).normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().trim();}
var STOP={das:1,dos:1,para:1,com:1,sem:1,por:1,uma:1,pela:1,pelo:1,nas:1,nos:1,que:1};
function palavras(desc){return norm(desc).split(/[^a-z0-9]+/).filter(function(w){return w.length>=3&&!STOP[w]&&!/^\d+$/.test(w);});}
function novoId(){try{if(window.crypto&&crypto.randomUUID)return crypto.randomUUID();}catch(e){}return Date.now().toString(36)+Math.random().toString(36).slice(2,10);}
function plural(n,um,varios){return n+' '+(n===1?um:varios);}

/* Valor digitado -> centavos inteiros (aceita 12,50 · 12.50 · 1.234,56 · 1,234.56) */
function parseValor(str){
  var s=String(str).trim().replace(/^R\$\s*/i,'').replace(/\s/g,'');
  if(!s)return null;
  var hasC=s.indexOf(',')>=0,hasD=s.indexOf('.')>=0;
  if(hasC&&hasD){
    var dec=s.lastIndexOf(',')>s.lastIndexOf('.')?',':'.';
    var th=dec===','?'.':',';
    var semMil=s.split(th).join('');
    if(semMil.split(dec).length>2)return null;
    if(!new RegExp('^\\d{1,3}(\\'+th+'\\d{3})+\\'+dec+'\\d{1,2}$').test(s))return null;
    s=semMil.replace(dec,'.');
  }else if(hasC){
    if(s.split(',').length>2)return null;
    s=s.replace(',','.');
  }else if(hasD){
    var parts=s.split('.');
    if(parts.length>2||parts[1].length===3){
      if(!/^\d{1,3}(\.\d{3})+$/.test(s))return null;
      s=parts.join('');
    }
  }
  var m=/^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if(!m)return null;
  var cents=parseInt(m[1],10)*100+parseInt((m[2]||'0').padEnd(2,'0'),10);
  if(!Number.isSafeInteger(cents)||cents>99999999999)return null;
  return cents;
}
function centsParaCampo(c){return Math.floor(c/100)+','+pad(c%100);}

/* ---------- Conta Google e sincronização (Supabase) ---------- */
var SB_URL='https://sbyuxgvrdzrqssitnibw.supabase.co';
var SB_KEY='sb_publishable_W8QceaUEPK6liJ__g4NNfg__VlZHJR2';
var SESS_KEY='didicost:sessao',SEMCONTA_KEY='didicost:semconta';
/* Login só existe no app publicado (a prévia no chat não tem manifesto) */
var PUBLICADO=!!document.querySelector('link[rel="manifest"]')&&location.protocol==='https:';
var syncEstado='';
function lerSessaoSalva(){try{var s=JSON.parse(localStorage.getItem(SESS_KEY));if(s&&s.refresh_token&&s.user&&s.user.id)return s;}catch(e){}return null;}
function guardarSessao(){try{if(sessao)localStorage.setItem(SESS_KEY,JSON.stringify(sessao));else localStorage.removeItem(SESS_KEY);}catch(e){}}
function sbFetch(path,o){
  o=o||{};var h=o.headers||{};h.apikey=SB_KEY;
  if(o.token)h.Authorization='Bearer '+o.token;
  if(o.body&&!h['Content-Type'])h['Content-Type']='application/json';
  return fetch(SB_URL+path,{method:o.method||'GET',headers:h,body:o.body,cache:'no-store'});
}
function usuarioDe(u){var m=u.user_metadata||{};return {id:u.id,email:u.email||'',nome:m.full_name||m.name||u.email||'Conta Google',foto:m.avatar_url||m.picture||''};}
function sessaoDeTokens(t){return {access_token:t.access_token,refresh_token:t.refresh_token,expires_at:Date.now()+(Number(t.expires_in)||3600)*1000,user:t.user?usuarioDe(t.user):null};}
function erroExpirada(){var e=new Error('sessao expirada');e.expirada=true;return e;}
var renovando=null;
function tokenValido(){
  if(!sessao||sessao.expirada)return Promise.reject(erroExpirada());
  if(sessao.expires_at-Date.now()>60000)return Promise.resolve(sessao.access_token);
  if(!renovando){
    renovando=sbFetch('/auth/v1/token?grant_type=refresh_token',{method:'POST',body:JSON.stringify({refresh_token:sessao.refresh_token})})
      .then(function(r){if(r.status===400||r.status===401||r.status===403)throw erroExpirada();if(!r.ok)throw new Error('rede');return r.json();})
      .then(function(t){var u=sessao.user;sessao=sessaoDeTokens(t);if(!sessao.user)sessao.user=u;guardarSessao();renovando=null;return sessao.access_token;},
            function(e){renovando=null;throw e;});
  }
  return renovando;
}
function lerJson(r){
  if(r.status===401){if(sessao)sessao.expires_at=0;throw new Error('nao autorizado');}
  if(!r.ok)throw new Error('http '+r.status);
  return r.status===204?null:r.json();
}
function metaKey(){return 'didicost:sync:'+sessao.user.id;}
function lerMeta(){try{return JSON.parse(localStorage.getItem(metaKey()))||{};}catch(e){return {};}}
function gravarMeta(m){try{localStorage.setItem(metaKey(),JSON.stringify(m));}catch(e){}}
function temDados(d){return !!d&&(d.lancamentos.length>0||d.fixas.length>0);}
function setSync(s){syncEstado=s;renderConta();}
var syncT=null;
function marcarPendente(){
  if(!sessao||!sessao.user)return;
  var m=lerMeta();m.pendente=true;m.versao=(m.versao||0)+1;gravarMeta(m);
  clearTimeout(syncT);syncT=setTimeout(sincronizar,1200);
}
var sincronizando=false,deNovo=false;
function sincronizar(){
  if(!PUBLICADO||!sessao||!sessao.user||sessao.expirada||erroLeitura)return Promise.resolve();
  if(sincronizando){deNovo=true;return Promise.resolve();}
  if(navigator.onLine===false){setSync('offline');return Promise.resolve();}
  sincronizando=true;setSync('andamento');
  var meta=lerMeta();
  return tokenValido().then(function(tk){
    if(meta.pendente)return enviar(tk);
    return sbFetch('/rest/v1/dados?select=conteudo,atualizado_em',{token:tk}).then(lerJson).then(function(rows){
      var r=rows&&rows[0];
      if(!r){if(temDados(state))return enviar(tk);setSync('ok');return;}
      if(r.atualizado_em!==meta.remotoEm){
        var d=normalizar(r.conteudo);
        state=d;gravarLocal();
        var m=lerMeta();m.remotoEm=r.atualizado_em;m.pendente=false;gravarMeta(m);
        render();
      }
      setSync('ok');
    });
  }).catch(erroSync).then(function(){
    sincronizando=false;
    if(deNovo){deNovo=false;return sincronizar();}
  });
}
function enviar(tk){
  var versao=lerMeta().versao||0;
  var corpo=JSON.stringify({user_id:sessao.user.id,conteudo:state,atualizado_em:new Date().toISOString()});
  return sbFetch('/rest/v1/dados?on_conflict=user_id',{method:'POST',token:tk,headers:{Prefer:'resolution=merge-duplicates,return=representation'},body:corpo})
    .then(lerJson).then(function(rows){
      var m=lerMeta();
      m.remotoEm=rows&&rows[0]?rows[0].atualizado_em:m.remotoEm;
      m.pendente=(m.versao||0)!==versao;
      gravarMeta(m);setSync('ok');
      if(m.pendente)deNovo=true;
    });
}
function erroSync(e){
  if(e&&e.expirada){if(sessao){sessao.expirada=true;guardarSessao();}setSync('expirada');renderBanners();return;}
  setSync(navigator.onLine===false?'offline':'erro');
}
function entrarGoogle(){
  if(!PUBLICADO){anunciar('O login com Google funciona no app publicado.');return;}
  if(navigator.onLine===false){anunciar('Sem internet. Conecte-se para entrar com Google.');return;}
  var volta=location.origin+location.pathname;
  location.href=SB_URL+'/auth/v1/authorize?provider=google&redirect_to='+encodeURIComponent(volta);
}
function limparUrl(){try{history.replaceState(null,'',location.pathname);}catch(e){}}
/* Volta do Google: tokens chegam no endereço (#access_token=...) ou um erro (?error=...) */
function lerRetornoLogin(){
  var h=new URLSearchParams((location.hash||'').replace(/^#/,'')),q=new URLSearchParams(location.search||'');
  var erro=h.get('error_description')||h.get('error')||q.get('error_description')||q.get('error');
  if(erro){limparUrl();return {erro:erro};}
  if(!h.get('access_token')||!h.get('refresh_token'))return null;
  limparUrl();
  return {access_token:h.get('access_token'),refresh_token:h.get('refresh_token'),expires_in:h.get('expires_in')};
}
function trocarPerfil(){
  erroLeitura=false;storageOk=true;filtro='';
  state=carregar();render();
}
function concluirLogin(t){
  var convidado=null;
  if(!sessao){try{var raw=localStorage.getItem('didicost:v1');if(raw)convidado=normalizar(JSON.parse(raw));}catch(e){convidado=null;}}
  setSync('andamento');
  sbFetch('/auth/v1/user',{token:t.access_token}).then(lerJson).then(function(u){
    sessao=sessaoDeTokens(t);sessao.user=usuarioDe(u);guardarSessao();
    try{localStorage.removeItem(SEMCONTA_KEY);}catch(e){}
    trocarPerfil();
    return sbFetch('/rest/v1/dados?select=conteudo,atualizado_em',{token:sessao.access_token}).then(lerJson);
  }).then(function(rows){
    var r=rows&&rows[0];
    var primeiro=sessao.user.nome.split(' ')[0];
    if(lerMeta().pendente){setSync('');sincronizar();anunciar('Olá de novo, '+primeiro+'! Enviando o que ficou pendente.');return;}
    if(r){
      state=normalizar(r.conteudo);gravarLocal();
      var m=lerMeta();m.remotoEm=r.atualizado_em;m.pendente=false;gravarMeta(m);
      render();setSync('ok');anunciar('Olá, '+primeiro+'! Seus dados foram carregados.');
      return;
    }
    if(temDados(state)){marcarPendente();setSync('');anunciar('Olá, '+primeiro+'!');return;}
    if(temDados(convidado)){
      abrirDialogo({titulo:'Levar seus dados para a conta?',
        corpo:'Este aparelho tem '+plural(convidado.lancamentos.length,'lançamento','lançamentos')+' e '+plural(convidado.fixas.length,'conta fixa','contas fixas')+' feitos sem conta. Quer guardar tudo na sua conta Google?',
        acoes:[
          {rotulo:'Levar para a conta',tipo:'primary',run:function(){state=convidado;salvar();try{localStorage.removeItem('didicost:v1');}catch(e){}return function(){render();anunciar('Dados levados para a conta de '+primeiro+'.');};}},
          {rotulo:'Começar a conta vazia',run:function(){salvar();return function(){render();anunciar('Conta de '+primeiro+' pronta, sem lançamentos.');};}}
        ]});
      setSync('');return;
    }
    salvar();anunciar('Olá, '+primeiro+'! Sua conta está pronta.');
  }).catch(function(e){
    if(!sessao||!sessao.user){setSync('');anunciar('Não foi possível entrar. Tente de novo.');return;}
    erroSync(e);
  });
}
function sair(){
  var m=sessao&&sessao.user?lerMeta():{};
  var corpo='Seus lançamentos continuam guardados na sua conta Google. Neste aparelho, o app volta para o modo sem conta.';
  if(m.pendente)corpo+=' Atenção: há alterações que ainda não foram enviadas. Elas ficam guardadas só neste aparelho até você entrar de novo.';
  abrirDialogo({titulo:'Sair da conta?',corpo:corpo,acoes:[cancelar(),{rotulo:'Sair da conta',tipo:'danger',run:function(){
    var s=sessao,pend=!!m.pendente;
    if(s&&!s.expirada)tokenValido().then(function(tk){return sbFetch('/auth/v1/logout',{method:'POST',token:tk});}).catch(function(){});
    if(s&&s.user&&!pend){try{localStorage.removeItem('didicost:v1:u:'+s.user.id);localStorage.removeItem('didicost:sync:'+s.user.id);}catch(e){}}
    sessao=null;guardarSessao();syncEstado='';
    return function(){trocarPerfil();anunciar('Você saiu da conta.');};
  }}]});
}
function horaCurta(iso){var d=new Date(iso);return isNaN(d)?'':pad(d.getHours())+':'+pad(d.getMinutes());}
function textoSync(){
  if(!sessao)return '';
  if(sessao.expirada||syncEstado==='expirada')return 'Sessão expirada. Entre de novo para sincronizar.';
  var m=lerMeta();
  if(syncEstado==='andamento')return 'Sincronizando…';
  if(syncEstado==='offline'||(m.pendente&&navigator.onLine===false))return 'Sem internet. As alterações são enviadas quando a conexão voltar.';
  if(syncEstado==='erro')return 'Não foi possível sincronizar agora. O app tenta de novo sozinho.';
  if(m.pendente)return 'Alterações aguardando envio.';
  if(m.remotoEm)return 'Sincronizado com a conta · '+horaCurta(m.remotoEm);
  return 'Conta conectada.';
}
function renderConta(){
  var linha=$('#conta-linha'),box=$('#conta-box');
  if(!PUBLICADO){linha.hidden=true;box.textContent='';var p0=document.createElement('p');p0.textContent='O login com Google fica disponível no app publicado. Aqui, os dados ficam só neste navegador.';box.appendChild(p0);return;}
  linha.hidden=false;linha.textContent='';box.textContent='';
  if(!sessao){
    linha.appendChild(document.createTextNode('Sem conta · dados só neste aparelho'));
    var p=document.createElement('p');p.textContent='Sem conta, os dados ficam só neste aparelho. Entre com sua conta Google para guardar seus lançamentos e ver os mesmos dados em qualquer celular ou computador.';
    var b=document.createElement('button');b.type='button';b.className='btn primary google';b.textContent='Entrar com Google';b.addEventListener('click',entrarGoogle);
    box.appendChild(p);box.appendChild(b);return;
  }
  var u=sessao.user;
  var av=document.createElement('span');av.className='avatar';av.setAttribute('aria-hidden','true');av.textContent=(u.nome||'?').charAt(0).toUpperCase();
  linha.appendChild(av);linha.appendChild(document.createTextNode(u.nome.split(' ')[0]+' · '+(sessao.expirada?'sessão expirada':'conta Google')));
  var topo=document.createElement('div');topo.className='quemsou';
  var av2=av.cloneNode(true);
  var info=document.createElement('div');
  var n=document.createElement('b');n.textContent=u.nome;
  var em=document.createElement('small');em.textContent=u.email;
  info.appendChild(n);info.appendChild(em);topo.appendChild(av2);topo.appendChild(info);box.appendChild(topo);
  var st=document.createElement('p');st.className='strong';st.setAttribute('aria-live','polite');st.textContent=textoSync();box.appendChild(st);
  var acts=document.createElement('div');acts.className='actions';
  if(sessao.expirada){
    var be=document.createElement('button');be.type='button';be.className='btn primary google';be.textContent='Entrar de novo com Google';be.addEventListener('click',entrarGoogle);acts.appendChild(be);
  }else{
    var bs=document.createElement('button');bs.type='button';bs.className='btn';bs.textContent='Sincronizar agora';bs.addEventListener('click',function(){sincronizar();});acts.appendChild(bs);
  }
  var bo=document.createElement('button');bo.type='button';bo.className='btn ghost-danger';bo.textContent='Sair da conta';bo.addEventListener('click',sair);acts.appendChild(bo);
  box.appendChild(acts);
}

/* ---------- Armazenamento ---------- */
var storageOk=true,erroLeitura=false;
function padrao(){return {version:1,categorias:['Outros'],palavras:{},lancamentos:[],fixas:[],settings:{limiteCentavos:null,alertaPct:80,avisos:{}}};}
function valido(d){
  if(!d||d.version!==1||!Array.isArray(d.categorias)||!Array.isArray(d.lancamentos)||typeof d.palavras!=='object'||d.palavras===null)return false;
  return d.lancamentos.every(function(l){return l&&typeof l.id==='string'&&(l.tipo==='gasto'||l.tipo==='renda')&&dataValida(l.data)&&Number.isSafeInteger(l.valorCentavos)&&typeof l.descricao==='string';});
}
function carregar(){
  var raw=null;
  try{raw=localStorage.getItem(chaveDados());}catch(e){storageOk=false;return padrao();}
  if(raw===null)return padrao();
  try{return normalizar(JSON.parse(raw));}
  catch(e){erroLeitura=true;return padrao();}
}
/* Confere e completa os dados lidos (do aparelho ou de um backup). Lança erro se o formato não servir. */
function normalizar(d){
  {
    if(!valido(d))throw new Error('formato');
    if(!d.settings||typeof d.settings!=='object')d.settings={limiteCentavos:null,alertaPct:80};
    if(!d.settings.avisos||typeof d.settings.avisos!=='object')d.settings.avisos={};
    if(!(d.settings.alertaPct>=1&&d.settings.alertaPct<=100))d.settings.alertaPct=80;
    if(!(Number.isSafeInteger(d.settings.limiteCentavos)&&d.settings.limiteCentavos>0))d.settings.limiteCentavos=null;
    if(!Array.isArray(d.fixas))d.fixas=[];
    d.fixas=d.fixas.filter(function(f){return f&&typeof f.id==='string'&&/^\d{4}-\d{2}$/.test(f.inicio)&&Number.isSafeInteger(f.valorCentavos)&&f.dia>=1&&f.dia<=31;});
    d.fixas.forEach(function(f){if(!f.excecoes||typeof f.excecoes!=='object')f.excecoes={};});
    if(d.categorias.indexOf('Outros')<0)d.categorias.push('Outros');
    return d;
  }
}
/* Cada perfil (sem conta, ou cada conta Google) guarda seus dados numa chave própria */
function chaveDados(){return sessao&&sessao.user?'didicost:v1:u:'+sessao.user.id:'didicost:v1';}
function gravarLocal(){try{localStorage.setItem(chaveDados(),JSON.stringify(state));return true;}catch(e){storageOk=false;return false;}}
function salvar(){
  if(erroLeitura)return false;
  try{Object.keys(state.settings.avisos).forEach(function(k){var r=RANK[estadoLimite(k).nivel];if(r<state.settings.avisos[k])state.settings.avisos[k]=r;});}catch(e){}
  if(!gravarLocal()){renderBanners();anunciar('Não foi possível salvar neste navegador.');return false;}
  marcarPendente();
  return true;
}
var retornoLogin=lerRetornoLogin();
var sessao=lerSessaoSalva();
var state=carregar();

/* ---------- Categorias ---------- */
function acharCat(nome){var n=norm(nome);for(var i=0;i<state.categorias.length;i++){if(norm(state.categorias[i])===n)return state.categorias[i];}return null;}
function catsOrdenadas(){
  var outras=state.categorias.filter(function(c){return c!=='Outros';}).sort(function(a,b){return a.localeCompare(b,'pt-BR');});
  return outras.concat(['Outros']);
}
function contarGastos(cat){
  return state.lancamentos.filter(function(l){return l.tipo==='gasto'&&l.categoria===cat;}).length
    +state.fixas.filter(function(f){return f.tipo==='gasto'&&f.categoria===cat;}).length;
}
function aprender(desc,cat){palavras(desc).forEach(function(w){state.palavras[w]=cat;});}
function sugerir(desc){
  var cont={},best=null,n=0;
  palavras(desc).forEach(function(w){var c=state.palavras[w];if(c&&state.categorias.indexOf(c)>=0){cont[c]=(cont[c]||0)+1;if(cont[c]>n){n=cont[c];best=c;}}});
  return best;
}
function moverCategoria(de,para,remover){
  state.lancamentos.forEach(function(l){if(l.categoria===de)l.categoria=para;});
  state.fixas.forEach(function(f){
    if(f.categoria===de)f.categoria=para;
    Object.keys(f.excecoes).forEach(function(k){var ex=f.excecoes[k];if(ex&&ex.categoria===de)ex.categoria=para;});
  });
  Object.keys(state.palavras).forEach(function(w){if(state.palavras[w]===de)state.palavras[w]=para;});
  var i=state.categorias.indexOf(de);
  if(remover){if(i>=0)state.categorias.splice(i,1);}else if(i>=0){state.categorias[i]=para;}
  if(filtro===de)filtro=remover?'':para;
}

/* ---------- Estado da tela ---------- */
var mes=hoje().slice(0,7),filtro='',editId=null,catTocada=false,catAuto=false;

/* ---------- Avisos ---------- */
var toastT=null;
function anunciar(msg){
  var t=$('#toast');t.textContent='';
  requestAnimationFrame(function(){t.textContent=msg;t.classList.add('show');});
  clearTimeout(toastT);toastT=setTimeout(function(){t.classList.remove('show');},3400);
}
function bloqueado(){
  if(erroLeitura){anunciar('Resolva o aviso no topo antes de continuar.');return true;}
  return false;
}

/* ---------- Camadas (painel e diálogos) ---------- */
var pilha=[];
var camadas=[$('#app'),$('#sheet'),$('#dlg')];
function atualizarInert(){
  var topo=pilha.length?pilha[pilha.length-1].el:null;
  camadas.forEach(function(el){el.inert=!!topo&&el!==topo;if(el.inert)el.setAttribute('aria-hidden','true');else el.removeAttribute('aria-hidden');});
  document.body.style.overflow=topo?'hidden':'';
}
function abrirCamada(el,foco){
  pilha.push({el:el,volta:document.activeElement});
  el.hidden=false;atualizarInert();
  setTimeout(function(){(foco||focaveis(el)[0]||el).focus();},30);
}
function fecharCamada(destinoFoco){
  var t=pilha.pop();if(!t)return;
  t.el.hidden=true;atualizarInert();
  var alvo=destinoFoco||t.volta;
  if(alvo&&document.contains(alvo)&&!alvo.hidden&&alvo.focus)alvo.focus();
}
function focaveis(el){return Array.prototype.filter.call(el.querySelectorAll('button,input,select,textarea,[tabindex]:not([tabindex="-1"])'),function(n){return !n.disabled&&n.offsetParent!==null;});}
document.addEventListener('keydown',function(e){
  if(!pilha.length)return;
  var topo=pilha[pilha.length-1].el;
  if(e.key==='Escape'){e.preventDefault();if(topo.id==='dlg')fecharCamada();else fecharForm();}
  else if(e.key==='Tab'){
    var f=focaveis(topo);if(!f.length)return;
    var i=f.indexOf(document.activeElement);
    if(e.shiftKey&&(i<=0)){e.preventDefault();f[f.length-1].focus();}
    else if(!e.shiftKey&&i===f.length-1){e.preventDefault();f[0].focus();}
  }
});
$('#sheet').addEventListener('click',function(e){if(e.target.id==='sheet')fecharForm();});
$('#dlg').addEventListener('click',function(e){if(e.target.id==='dlg')fecharCamada();});

/* Diálogo genérico: acoes = [{rotulo,tipo,run}] · run devolve false para manter aberto, ou uma função para rodar depois de fechar */
function abrirDialogo(o){
  $('#dlg-title').textContent=o.titulo;
  var corpo=$('#dlg-body');corpo.textContent='';
  if(typeof o.corpo==='string'){var p=document.createElement('p');p.textContent=o.corpo;corpo.appendChild(p);}
  else if(o.corpo)corpo.appendChild(o.corpo);
  var acts=$('#dlg-actions');acts.textContent='';
  var focoInicial=null;
  o.acoes.forEach(function(a,idx){
    var b=document.createElement('button');b.type='button';b.className='btn'+(a.tipo?' '+a.tipo:'');b.textContent=a.rotulo;
    b.addEventListener('click',function(){
      var r=a.run?a.run():true;
      if(r===false)return;
      fecharCamada(o.focoDepois);
      if(typeof r==='function')r();
    });
    acts.appendChild(b);
    if(idx===0)focoInicial=b;
  });
  abrirCamada($('#dlg'),o.foco||focoInicial);
}
function cancelar(){return {rotulo:'Cancelar',run:function(){return true;}};}

/* ---------- Limite, alerta e notificações ---------- */
var RANK={sem:0,ok:0,alerta:1,excedido:2};
function gastosDoMes(k){
  return state.lancamentos.filter(function(l){return l.tipo==='gasto'&&l.data.slice(0,7)===k;})
    .concat(ocorrenciasFixas(k).filter(function(o){return o.tipo==='gasto';}));
}
function soma(lista){return lista.reduce(function(s,l){return s+l.valorCentavos;},0);}
function pctTxt(parte,todo){var t=Math.floor(parte*1000/todo);return (t/10).toLocaleString('pt-BR',{minimumFractionDigits:1,maximumFractionDigits:1})+'%';}
function estadoLimite(k){
  var lim=state.settings.limiteCentavos,total=soma(gastosDoMes(k));
  if(!lim)return {nivel:'sem',total:total};
  var nivel=total>=lim?'excedido':(total*100>=lim*state.settings.alertaPct?'alerta':'ok');
  return {nivel:nivel,total:total,lim:lim};
}
function textoEstado(e,k){
  if(e.nivel==='ok')return 'Dentro do limite';
  if(e.nivel==='alerta')return 'Atenção: '+pctTxt(e.total,e.lim)+' do limite'+(k?' de '+mesLabel(k).toLowerCase():'');
  if(e.total>e.lim)return 'Limite'+(k?' de '+mesLabel(k).toLowerCase():'')+' ultrapassado em '+brl(e.total-e.lim);
  return 'Limite'+(k?' de '+mesLabel(k).toLowerCase():'')+' atingido';
}
var ICONE={ok:'✓',alerta:'⚠',excedido:'⛔'};
function notificar(titulo,corpo){
  try{
    if(!('Notification' in window)||Notification.permission!=='granted')return;
    var opts={body:corpo,tag:'didicost-limite'};
    if(navigator.serviceWorker&&navigator.serviceWorker.controller){
      navigator.serviceWorker.ready.then(function(r){return r.showNotification(titulo,opts);}).catch(function(){});
    }else{new Notification(titulo,opts);}
  }catch(e){}
}
/* Avisa só quando o mês sobe de nível (normal → alerta → ultrapassado) */
function verificarAlertas(meses){
  var msgs=[];
  meses.filter(function(k,i){return meses.indexOf(k)===i;}).forEach(function(k){
    var e=estadoLimite(k),r=RANK[e.nivel],antes=state.settings.avisos[k]||0;
    if(r>antes){var t=textoEstado(e,k)+'.';msgs.push(ICONE[e.nivel]+' '+t);notificar('DIDICOST',t);}
    state.settings.avisos[k]=r;
  });
  return msgs.join(' ');
}

function renderLimitePill(){
  var p=$('#lim-pill'),e=estadoLimite(mes);
  if(e.nivel==='sem'){p.hidden=true;p.textContent='';return;}
  p.hidden=false;p.className='st '+e.nivel;
  p.textContent=ICONE[e.nivel]+' '+(e.nivel==='ok'?'Dentro do limite · '+pctTxt(e.total,e.lim):textoEstado(e));
}

/* ---------- Aba Resumo ---------- */
var CORES=['#F2E94E','#82B4FF','#FFC56B','#7EE0A8','#FF8A66','#E87A8C','#B9A3FF','#6FD3E0','#FFFBB0','#C9E07E'];
function corDe(cat){
  if(cat==='Outros')return '#A3AAC0';
  var i=catsOrdenadas().indexOf(cat);
  return CORES[(i<0?0:i)%CORES.length];
}
/* Percentuais em décimos que sempre somam 100,0% (maiores restos) */
function percentuais(valores,total){
  var base=valores.map(function(v){return Math.floor(v*1000/total);});
  var falta=1000-base.reduce(function(a,b){return a+b;},0);
  var ordem=valores.map(function(v,i){return {i:i,r:v*1000%total};}).sort(function(a,b){return b.r-a.r;});
  for(var j=0;j<falta;j++)base[ordem[j%ordem.length].i]++;
  return base.map(function(t){return (t/10).toLocaleString('pt-BR',{minimumFractionDigits:1,maximumFractionDigits:1})+'%';});
}
function desenharRosca(fatias,total){
  var NS='http://www.w3.org/2000/svg';
  function el(n,a){var e=document.createElementNS(NS,n);for(var k in a)e.setAttribute(k,a[k]);return e;}
  var svg=el('svg',{viewBox:'0 0 220 220','class':'donut',role:'img','aria-label':'Gráfico de rosca dos gastos de '+mesLabel(mes).toLowerCase()+'. Os valores estão na lista abaixo.'});
  var r=80,C=2*Math.PI*r,acc=0,gap=fatias.length>1?2.5:0;
  svg.appendChild(el('circle',{cx:110,cy:110,r:r,fill:'none',stroke:'rgba(255,255,255,0.06)','stroke-width':34}));
  fatias.forEach(function(f){
    var len=C*f.cents/total;
    svg.appendChild(el('circle',{cx:110,cy:110,r:r,fill:'none',stroke:f.cor,'stroke-width':34,
      'stroke-dasharray':Math.max(len-gap,0.8)+' '+C,'stroke-dashoffset':-acc,transform:'rotate(-90 110 110)'}));
    acc+=len;
  });
  var t1=el('text',{x:110,y:102,'text-anchor':'middle',style:'fill:var(--muted);font:700 11px var(--body);letter-spacing:.16em'});t1.textContent='GASTOS';
  var t2=el('text',{x:110,y:126,'text-anchor':'middle',style:'fill:var(--text);font:800 19px var(--display)'});t2.textContent=brl(total);
  svg.appendChild(t1);svg.appendChild(t2);
  return svg;
}
function renderResumoTab(){
  var gastos=gastosDoMes(mes),total=soma(gastos);
  var rendas=doMes().filter(function(l){return l.tipo==='renda';}),renda=soma(rendas);
  $('#res-total').textContent=brl(total);
  $('#res-renda').textContent=rendas.length?'Renda '+brl(renda)+' · Saldo '+brl(renda-total):'Renda não registrada em '+mesLabel(mes).toLowerCase()+'.';

  /* Limite */
  var box=$('#lim-box');box.textContent='';
  var e=estadoLimite(mes);
  var h=document.createElement('h3');h.className='flabel';h.style.margin='0';h.textContent='Limite do mês';box.appendChild(h);
  if(e.nivel==='sem'){
    var p=document.createElement('p');p.textContent='Limite não definido.';box.appendChild(p);
    var b=document.createElement('button');b.type='button';b.className='btn';b.textContent='Definir limite';b.style.alignSelf='flex-start';
    b.addEventListener('click',function(){irPara('aj');setTimeout(function(){$('#f-lim').focus();},50);});
    box.appendChild(b);
  }else{
    var kv=document.createElement('div');kv.className='kv2';
    var a1=document.createElement('span');a1.textContent='Usado ';var b1=document.createElement('b');b1.textContent=pctTxt(e.total,e.lim);a1.appendChild(b1);
    var a2=document.createElement('span');a2.textContent='Limite ';var b2=document.createElement('b');b2.textContent=brl(e.lim);a2.appendChild(b2);
    kv.appendChild(a1);kv.appendChild(a2);box.appendChild(kv);
    var m=document.createElement('div');m.className='meter';m.setAttribute('role','img');m.setAttribute('aria-label',pctTxt(e.total,e.lim)+' do limite usado');
    var i=document.createElement('i');i.className=e.nivel;i.style.width=Math.min(100,e.total*100/e.lim)+'%';m.appendChild(i);box.appendChild(m);
    var st=document.createElement('p');st.className='st '+e.nivel;st.textContent=ICONE[e.nivel]+' '+textoEstado(e);box.appendChild(st);
    var rest=document.createElement('p');rest.className='strong';
    rest.textContent='Restante: '+brl(e.lim-e.total)+' (limite − gastos) · aviso em '+state.settings.alertaPct+'%';
    box.appendChild(rest);
  }
  renderLimitePill();

  /* Roleta por categoria */
  var porCat={};
  gastos.forEach(function(l){porCat[l.categoria]=(porCat[l.categoria]||0)+l.valorCentavos;});
  var qtd={};gastos.forEach(function(l){qtd[l.categoria]=(qtd[l.categoria]||0)+1;});
  var com=Object.keys(porCat).filter(function(c){return porCat[c]>0;}).sort(function(a,b){return porCat[b]-porCat[a]||a.localeCompare(b,'pt-BR');});
  var sem=catsOrdenadas().filter(function(c){return !porCat[c];});
  var wrap=$('#donut-wrap'),ul=$('#legend'),vz=$('#res-vazio');
  wrap.textContent='';ul.textContent='';
  if(!total){
    vz.hidden=false;vz.textContent='Nenhum gasto em '+mesLabel(mes).toLowerCase()+'. A roleta aparece quando houver gastos.';
  }else{
    vz.hidden=true;vz.textContent='';
    var fatias=com.map(function(c){return {cat:c,cents:porCat[c],cor:corDe(c)};});
    wrap.appendChild(desenharRosca(fatias,total));
    var pcts=percentuais(fatias.map(function(f){return f.cents;}),total);
    fatias.forEach(function(f,idx){ul.appendChild(linhaLegenda(f.cat,f.cor,f.cents,pcts[idx],qtd[f.cat]));});
  }
  sem.forEach(function(c){ul.appendChild(linhaLegenda(c,corDe(c),0,total?'0,0%':'—',0,true));});
}
function linhaLegenda(cat,cor,cents,pct,n,zero){
  var li=document.createElement('li');if(zero)li.className='zero';
  var sw=document.createElement('span');sw.className='sw';sw.style.background=cor;sw.setAttribute('aria-hidden','true');
  var nm=document.createElement('span');nm.className='n';nm.textContent=cat;
  var sm=document.createElement('small');sm.textContent=zero?'Sem gastos no mês':plural(n,'lançamento','lançamentos');nm.appendChild(sm);
  var v=document.createElement('span');v.className='v';v.textContent=brl(cents);
  var sp=document.createElement('small');sp.textContent=pct;v.appendChild(sp);
  li.appendChild(sw);li.appendChild(nm);li.appendChild(v);
  return li;
}

/* ---------- Ajustes: limite e notificações ---------- */
function renderLimiteForm(){
  if(document.activeElement!==$('#f-lim'))$('#f-lim').value=state.settings.limiteCentavos?centsParaCampo(state.settings.limiteCentavos):'';
  if(document.activeElement!==$('#f-alerta'))$('#f-alerta').value=state.settings.alertaPct;
  $('#lim-remover').disabled=!state.settings.limiteCentavos;
  renderNotif();
}
function renderNotif(){
  var txt=$('#notif-txt'),btn=$('#notif-btn');
  if(!('Notification' in window)){
    txt.textContent='Notificações do iPhone: disponíveis depois de instalar o app na tela de início (iOS 16.4 ou mais novo). Até lá, o aviso aparece dentro do app.';
    btn.hidden=true;return;
  }
  var p=Notification.permission;
  if(p==='granted'){txt.textContent='Notificações ativadas. Você recebe um aviso ao chegar ao percentual escolhido e ao passar do limite.';btn.hidden=true;}
  else if(p==='denied'){txt.textContent='Notificações bloqueadas. No iPhone, libere em Ajustes › Notificações › DIDICOST. O aviso continua aparecendo dentro do app.';btn.hidden=true;}
  else{txt.textContent='Receba um aviso no celular quando os gastos chegarem ao percentual escolhido.';btn.hidden=false;}
}
$('#notif-btn').addEventListener('click',function(){
  try{
    var r=Notification.requestPermission(function(){renderNotif();});
    if(r&&r.then)r.then(function(){renderNotif();},function(){renderNotif();});
  }catch(e){renderNotif();}
});
function sincronizarAvisos(){state.settings.avisos={};var k=hoje().slice(0,7);state.settings.avisos[k]=RANK[estadoLimite(k).nivel];}
$('#lim-form').addEventListener('submit',function(e){
  e.preventDefault();
  if(bloqueado())return;
  var fl=$('#f-lim'),fa=$('#f-alerta'),el=$('#e-lim'),ea=$('#e-alerta'),primeiro=null;
  el.textContent='';ea.textContent='';fl.removeAttribute('aria-invalid');fa.removeAttribute('aria-invalid');
  var lim=fl.value.trim()?parseValor(fl.value):null;
  var a=fa.value.trim(),pct=/^\d+$/.test(a)?parseInt(a,10):NaN;
  if(fl.value.trim()&&(lim===null||lim<=0)){el.textContent='Informe um valor maior que zero, como 3.200,00.';fl.setAttribute('aria-invalid','true');primeiro=fl;}
  if(!(pct>=1&&pct<=100)){ea.textContent='Use um número de 1 a 100.';fa.setAttribute('aria-invalid','true');if(!primeiro)primeiro=fa;}
  if(primeiro){primeiro.focus();return;}
  state.settings.limiteCentavos=lim;state.settings.alertaPct=pct;
  sincronizarAvisos();
  var ok=salvar();fl.blur();fa.blur();render();
  if(ok)anunciar(lim?'Limite salvo: '+brl(lim)+', aviso em '+pct+'%.':'Sem limite. Aviso em '+pct+'% guardado para quando houver limite.');
});
$('#lim-remover').addEventListener('click',function(){
  abrirDialogo({titulo:'Remover limite?',corpo:'O app deixa de comparar os gastos com um limite. Seus lançamentos não mudam.',focoDepois:$('#f-lim'),acoes:[cancelar(),{rotulo:'Remover limite',tipo:'danger',run:function(){
    state.settings.limiteCentavos=null;sincronizarAvisos();var ok=salvar();
    return function(){render();if(ok)anunciar('Limite removido.');};
  }}]});
});

/* ---------- Backup ---------- */
var DIA=864e5;
function dataBR(iso){var d=new Date(iso);return pad(d.getDate())+'/'+pad(d.getMonth()+1)+'/'+d.getFullYear();}
function primeiroRegistro(){
  var datas=state.lancamentos.map(function(l){return Date.parse(l.criadoEm);}).concat(state.fixas.map(function(f){return Date.parse(f.criadoEm);})).filter(function(n){return !isNaN(n);});
  return datas.length?Math.min.apply(null,datas):null;
}
/* Lembrete: nunca fez backup (depois de 3 dias com dados) ou último backup há mais de 30 dias */
function precisaLembrete(){
  if(sessao&&!sessao.expirada)return null;
  if(!state.lancamentos.length&&!state.fixas.length)return null;
  var agora=Date.now(),lap=state.settings.lembrarApos;
  if(lap&&agora<Date.parse(lap))return null;
  var ub=state.settings.ultimoBackup;
  if(!ub){var pr=primeiroRegistro();if(pr===null||agora-pr<3*DIA)return null;return 'Você ainda não fez nenhum backup.';}
  var dias=Math.floor((agora-Date.parse(ub))/DIA);
  return dias>30?'Seu último backup foi há '+dias+' dias.':null;
}
function renderBackupStatus(){
  var ub=state.settings.ultimoBackup,el=$('#backup-status');
  if(!ub){el.textContent='Nenhum backup feito ainda.';return;}
  var dias=Math.floor((Date.now()-Date.parse(ub))/DIA);
  el.textContent='Último backup: '+dataBR(ub)+(dias===0?' (hoje)':dias===1?' (ontem)':' ('+dias+' dias atrás)')+'.';
}
function baixarArquivo(texto,nome){
  var url=URL.createObjectURL(new Blob([texto],{type:'application/json'}));
  var a=document.createElement('a');a.href=url;a.download=nome;a.hidden=true;document.body.appendChild(a);a.click();a.remove();
  setTimeout(function(){URL.revokeObjectURL(url);},5000);
}
function exportarBackup(){
  if(erroLeitura){anunciar('Não há dados legíveis para exportar.');return;}
  var texto=JSON.stringify({app:'DIDICOST',formato:1,exportadoEm:new Date().toISOString(),dados:state});
  var nome='didicost-backup-'+hoje()+'.json';
  function feito(){
    state.settings.ultimoBackup=new Date().toISOString();state.settings.lembrarApos=null;
    salvar();renderBanners();renderBackupStatus();
    anunciar('Backup gerado: '+nome+'. Guarde o arquivo em um lugar seguro.');
  }
  function porDownload(){try{baixarArquivo(texto,nome);feito();}catch(e){anunciar('Não foi possível gerar o arquivo neste navegador.');}}
  var file=null;try{file=new File([texto],nome,{type:'application/json'});}catch(e){}
  if(file&&navigator.canShare&&navigator.share){
    var pode=false;try{pode=navigator.canShare({files:[file]});}catch(e){}
    if(pode){
      navigator.share({files:[file],title:'Backup DIDICOST'}).then(feito,function(err){
        if(err&&err.name==='AbortError')anunciar('Backup cancelado. Nada foi salvo.');else porDownload();
      });
      return;
    }
  }
  porDownload();
}
$('#bk-exp').addEventListener('click',exportarBackup);
$('#bk-imp').addEventListener('click',function(){var f=$('#bk-file');f.value='';f.click();});
$('#bk-file').addEventListener('change',function(){
  var f=this.files&&this.files[0];if(!f)return;
  function invalido(msg){abrirDialogo({titulo:'Backup não aceito',corpo:msg+' Nada foi alterado.',focoDepois:$('#bk-imp'),acoes:[{rotulo:'Entendi',tipo:'primary',run:function(){return true;}}]});}
  if(f.size>20*1024*1024){invalido('O arquivo é grande demais para ser um backup do DIDICOST.');return;}
  var rd=new FileReader();
  rd.onerror=function(){invalido('Não foi possível ler o arquivo.');};
  rd.onload=function(){
    var obj,d;
    try{obj=JSON.parse(rd.result);}catch(e){invalido('Este arquivo não é um backup do DIDICOST ou está danificado.');return;}
    if(!obj||obj.app!=='DIDICOST'){invalido('Este arquivo não é um backup do DIDICOST.');return;}
    if(obj.formato!==1){invalido('Este backup foi feito por uma versão do app que esta não reconhece.');return;}
    try{d=normalizar(obj.dados);}catch(e){invalido('O backup está incompleto ou danificado.');return;}
    var nL=d.lancamentos.length,nF=d.fixas.length;
    var gastos=d.lancamentos.filter(function(l){return l.tipo==='gasto';}).reduce(function(s,l){return s+l.valorCentavos;},0);
    var quando=obj.exportadoEm&&!isNaN(Date.parse(obj.exportadoEm))?' de '+dataBR(obj.exportadoEm):'';
    var atual=erroLeitura?'os dados ilegíveis deste aparelho':'todos os dados atuais deste aparelho ('+plural(state.lancamentos.length,'lançamento','lançamentos')+', '+plural(state.fixas.length,'conta fixa','contas fixas')+')';
    var acoes=[cancelar()];
    if(!erroLeitura&&(state.lancamentos.length||state.fixas.length)){
      acoes.push({rotulo:'Exportar os dados atuais primeiro',run:function(){exportarBackup();return false;}});
    }
    acoes.push({rotulo:'Substituir pelos dados do backup',tipo:'danger',run:function(){
      if(obj.exportadoEm&&!isNaN(Date.parse(obj.exportadoEm)))d.settings.ultimoBackup=obj.exportadoEm;
      d.settings.lembrarApos=null;
      state=d;erroLeitura=false;
      var ok=salvar();
      return function(){render();if(ok)anunciar('Backup restaurado: '+plural(nL,'lançamento','lançamentos')+' e '+plural(nF,'conta fixa','contas fixas')+'.');};
    }});
    abrirDialogo({titulo:'Restaurar backup?',focoDepois:$('#bk-imp'),
      corpo:'Backup'+quando+' com '+plural(nL,'lançamento','lançamentos')+', '+plural(nF,'conta fixa','contas fixas')+', '+plural(d.categorias.length,'categoria','categorias')+' e '+brl(gastos)+' em gastos lançados. Ele vai substituir '+atual+'. Esta ação não pode ser desfeita.',
      acoes:acoes});
  };
  rd.readAsText(f);
});

/* ---------- Investimentos ---------- */
/* Conta como investimento todo gasto cuja categoria tenha "invest" no nome (Investimento, Investimentos, INVESTIMENTO…) */
function ehInvest(l){return l.tipo==='gasto'&&!!l.categoria&&norm(l.categoria).indexOf('invest')>=0;}
function mesCurto(k){var p=k.split('-').map(Number);var s=new Intl.DateTimeFormat('pt-BR',{month:'short'}).format(new Date(p[0],p[1]-1,1)).replace('.','');return s+'/'+String(p[0]).slice(2);}
/* Todos os aportes: lançamentos (inclui parcelas) + contas fixas de investimento até o mês atual */
function aportes(){
  var atual=hoje().slice(0,7),out=state.lancamentos.filter(ehInvest);
  state.fixas.forEach(function(f){
    if(f.tipo!=='gasto')return;
    var fim=f.fim&&f.fim<atual?f.fim:atual;
    for(var k=f.inicio,n=0;k<=fim&&n<600;k=addMes(k,1),n++){
      var o=ocorrenciaFixa(f,k);
      if(o&&ehInvest(o))out.push(o);
    }
  });
  return out;
}
function renderInvest(){
  var hj=hoje(),todos=aportes();
  var feitos=todos.filter(function(l){return l.data<=hj;});
  var futuros=todos.filter(function(l){return l.data>hj;});
  var total=soma(feitos);
  var noMes=soma(state.lancamentos.filter(function(l){return ehInvest(l)&&l.data.slice(0,7)===mes;}).concat(ocorrenciasFixas(mes).filter(ehInvest)));
  var vazio=!todos.length&&!state.fixas.some(ehInvest);
  $('#inv-vazio').hidden=!vazio;
  $('#inv-cont').hidden=vazio;
  var temCat=state.categorias.some(function(c){return norm(c).indexOf('invest')>=0;});
  $('#inv-criar').hidden=temCat;
  if(vazio)return;
  $('#inv-total').textContent=brl(total);
  var primeiro=feitos.length?feitos.reduce(function(a,l){return l.data<a?l.data:a;},feitos[0].data):null;
  $('#inv-sub').textContent=feitos.length?plural(feitos.length,'aporte','aportes')+' desde '+mesLabel(primeiro.slice(0,7)).toLowerCase():'Nenhum aporte até hoje.';
  $('#inv-mes-lbl').textContent='Em '+mesLabel(mes).toLowerCase();
  $('#inv-mes').textContent=brl(noMes);
  $('#inv-prog').textContent=brl(soma(futuros));
  var nf=state.fixas.filter(function(f){return ehInvest(f)&&(!f.fim||f.fim>=hj.slice(0,7));});
  $('#inv-fixas').textContent=nf.length?plural(nf.length,'aporte fixo ativo','aportes fixos ativos')+': '+brl(soma(nf))+' por mês.':'';
  $('#inv-fixas').hidden=!nf.length;

  /* Últimos 12 meses */
  var atual=hj.slice(0,7),meses=[];
  for(var i=11;i>=0;i--)meses.push(addMes(atual,-i));
  var porMes={};feitos.forEach(function(l){var k=l.data.slice(0,7);porMes[k]=(porMes[k]||0)+l.valorCentavos;});
  var max=Math.max.apply(null,meses.map(function(k){return porMes[k]||0;}))||1;
  var box=$('#inv-meses');box.textContent='';
  meses.forEach(function(k){
    var v=porMes[k]||0;
    var row=document.createElement('div');row.className='mbar'+(v?'':' zero');
    var lb=document.createElement('span');lb.className='ml';lb.textContent=mesCurto(k);
    var tr=document.createElement('span');tr.className='mt';tr.setAttribute('aria-hidden','true');
    var fl=document.createElement('i');fl.style.width=(v?Math.max(2,v*100/max):0)+'%';tr.appendChild(fl);
    var vl=document.createElement('span');vl.className='mv';vl.textContent=brl(v);
    row.appendChild(lb);row.appendChild(tr);row.appendChild(vl);box.appendChild(row);
  });

  /* Por destino: agrupa pela descrição */
  var grupos={},ordem=[];
  feitos.forEach(function(l){var k=norm(l.descricao);if(!grupos[k]){grupos[k]={nome:l.descricao,cents:0,n:0};ordem.push(k);}grupos[k].cents+=l.valorCentavos;grupos[k].n++;});
  var lista=ordem.map(function(k){return grupos[k];}).sort(function(a,b){return b.cents-a.cents||a.nome.localeCompare(b.nome,'pt-BR');});
  var ul=$('#inv-destinos');ul.textContent='';
  if(!lista.length){var li0=document.createElement('li');li0.className='zero';li0.textContent='Os aportes aparecem aqui quando a data deles chegar.';ul.appendChild(li0);return;}
  var pcts=percentuais(lista.map(function(g){return g.cents;}),total);
  lista.forEach(function(g,idx){ul.appendChild(linhaLegenda(g.nome,CORES[idx%CORES.length],g.cents,pcts[idx],g.n));});
}
$('#inv-criar').addEventListener('click',function(){
  if(bloqueado())return;
  if(!state.categorias.some(function(c){return norm(c).indexOf('invest')>=0;}))state.categorias.push('Investimento');
  var ok=salvar();render();
  if(ok)anunciar('Categoria "Investimento" criada. Use-a ao adicionar seus aportes.');
});

/* ---------- Renderização ---------- */
function render(){renderBanners();renderMes();renderResumo();renderFiltro();renderLista();renderCats();renderFixas();renderResumoTab();renderLimiteForm();renderBackupStatus();renderConta();renderInvest();}

function renderBanners(){
  var box=$('#banners');box.textContent='';
  if(erroLeitura){
    var b=document.createElement('div');b.className='banner';b.setAttribute('role','alert');
    var p=document.createElement('p');p.textContent='Os dados salvos neste aparelho não puderam ser lidos. Nada foi apagado. Você pode restaurar um backup em Ajustes ou começar do zero (isso substitui os dados ilegíveis).';
    var bt=document.createElement('button');bt.type='button';bt.className='btn danger';bt.textContent='Começar do zero';
    bt.addEventListener('click',function(){
      abrirDialogo({titulo:'Começar do zero?',corpo:'Os dados ilegíveis serão substituídos por um app vazio. Esta ação não pode ser desfeita.',
        acoes:[cancelar(),{rotulo:'Começar do zero',tipo:'danger',run:function(){erroLeitura=false;state=padrao();salvar();return function(){render();anunciar('App reiniciado sem lançamentos.');$('#fab').focus();};}}]});
    });
    b.appendChild(p);b.appendChild(bt);box.appendChild(b);
  }else if(!storageOk){
    var b2=document.createElement('div');b2.className='banner';b2.setAttribute('role','alert');
    var p2=document.createElement('p');p2.textContent='Este navegador não está deixando o app salvar. O que você adicionar agora some ao fechar. Verifique se não está em uma aba privada.';
    b2.appendChild(p2);box.appendChild(b2);
  }
  var semConta=false;try{semConta=localStorage.getItem(SEMCONTA_KEY)==='1';}catch(e){}
  if(PUBLICADO&&!sessao&&!semConta&&!erroLeitura){
    var bw=document.createElement('div');bw.className='banner soft';
    var pw=document.createElement('p');pw.textContent='Entre com sua conta Google para guardar seus lançamentos e ver os mesmos dados em qualquer aparelho. Sem conta, tudo fica só neste celular.';
    var aw=document.createElement('div');aw.className='actions';
    var bg=document.createElement('button');bg.type='button';bg.className='btn primary';bg.textContent='Entrar com Google';bg.addEventListener('click',entrarGoogle);
    var bn=document.createElement('button');bn.type='button';bn.className='btn';bn.textContent='Usar sem conta';
    bn.addEventListener('click',function(){try{localStorage.setItem(SEMCONTA_KEY,'1');}catch(e){}renderBanners();anunciar('Tudo bem. Você pode entrar depois em Ajustes.');});
    aw.appendChild(bg);aw.appendChild(bn);bw.appendChild(pw);bw.appendChild(aw);box.appendChild(bw);
  }
  if(sessao&&sessao.expirada){
    var bx=document.createElement('div');bx.className='banner';
    var px=document.createElement('p');px.textContent='Sua sessão do Google expirou. Seus lançamentos continuam aqui; entre de novo para voltar a sincronizar.';
    var ax=document.createElement('button');ax.type='button';ax.className='btn primary';ax.textContent='Entrar de novo';ax.addEventListener('click',entrarGoogle);
    bx.appendChild(px);bx.appendChild(ax);box.appendChild(bx);
  }
  var lem=!erroLeitura&&storageOk?precisaLembrete():null;
  if(lem){
    var b3=document.createElement('div');b3.className='banner soft';
    var p3=document.createElement('p');p3.textContent=lem+' Guarde uma cópia para não perder seus lançamentos.';
    var ac=document.createElement('div');ac.className='actions';
    var bf=document.createElement('button');bf.type='button';bf.className='btn primary';bf.textContent='Fazer backup';
    bf.addEventListener('click',function(){exportarBackup();});
    var bd=document.createElement('button');bd.type='button';bd.className='btn';bd.textContent='Lembrar em 7 dias';
    bd.addEventListener('click',function(){state.settings.lembrarApos=new Date(Date.now()+7*864e5).toISOString();salvar();renderBanners();anunciar('Vou lembrar de novo em 7 dias.');});
    ac.appendChild(bf);ac.appendChild(bd);b3.appendChild(p3);b3.appendChild(ac);box.appendChild(b3);
  }
  $('#fab').disabled=erroLeitura;
}

function renderMes(){$('#mes-label').textContent=mesLabel(mes);}

/* Contas fixas não são copiadas mês a mês: cada mês calcula a sua ocorrência (com ajustes feitos só naquele mês) */
function ocorrenciaFixa(f,k){
  if(k<f.inicio||(f.fim&&k>f.fim))return null;
  var ex=f.excecoes[k];
  if(ex&&ex.removido)return null;
  var o={id:'fx:'+f.id+':'+k,fixaId:f.id,mesRef:k,virtual:true,tipo:f.tipo,data:dataComDia(k,f.dia),descricao:f.descricao,valorCentavos:f.valorCentavos,categoria:f.categoria,criadoEm:f.criadoEm};
  if(ex)['descricao','valorCentavos','data','categoria'].forEach(function(p){if(ex[p]!=null)o[p]=ex[p];});
  return o;
}
function ocorrenciasFixas(k){
  var out=[];
  state.fixas.forEach(function(f){var o=ocorrenciaFixa(f,k);if(o)out.push(o);});
  return out;
}
function acharFixa(id){return state.fixas.filter(function(f){return f.id===id;})[0]||null;}
function doMes(){return state.lancamentos.filter(function(l){return l.data.slice(0,7)===mes;}).concat(ocorrenciasFixas(mes));}

function renderResumo(){
  var itens=doMes(),renda=0,gastos=0,nRenda=0;
  itens.forEach(function(l){if(l.tipo==='renda'){renda+=l.valorCentavos;nRenda++;}else gastos+=l.valorCentavos;});
  $('#gastos-val').textContent=brl(gastos);
  var sv=$('#saldo-val'),sl=$('#saldo-lbl'),sn=$('#saldo-note');
  sv.classList.remove('neg');
  if(nRenda===0){
    $('#renda-val').textContent='Não registrada';
    sl.textContent='Saldo do mês';sv.textContent='—';
    sn.hidden=false;sn.textContent='Renda não registrada. Adicione a renda do mês para ver o saldo.';
  }else{
    $('#renda-val').textContent=brl(renda);
    var saldo=renda-gastos;
    sv.textContent=brl(saldo);
    if(saldo<0){sv.classList.add('neg');sl.textContent='Saldo negativo';}else sl.textContent='Saldo do mês';
    sn.hidden=true;sn.textContent='';
  }
}

function renderFiltro(){
  var sel=$('#filtro');sel.textContent='';
  sel.appendChild(new Option('Todos','')); sel.appendChild(new Option('Só renda','__renda'));
  catsOrdenadas().forEach(function(c){sel.appendChild(new Option(c,c));});
  if(filtro&&filtro!=='__renda'&&state.categorias.indexOf(filtro)<0)filtro='';
  sel.value=filtro;
}

function passaFiltro(l){
  if(!filtro)return true;
  if(filtro==='__renda')return l.tipo==='renda';
  return l.tipo==='gasto'&&l.categoria===filtro;
}

function renderLista(){
  var ul=$('#lista');ul.textContent='';
  var doM=doMes();
  var itens=doM.filter(passaFiltro).sort(function(a,b){return b.data.localeCompare(a.data)||String(b.criadoEm).localeCompare(String(a.criadoEm));});
  itens.forEach(function(l){
    var li=document.createElement('li');
    var b=document.createElement('button');b.type='button';b.className='item'+(l.tipo==='renda'?' renda':'');b.dataset.id=l.id;
    var txt=document.createElement('span');
    var d=document.createElement('span');d.className='d';d.textContent=l.descricao;
    var meta=dataCurta(l.data)+' · '+(l.tipo==='renda'?'Renda':l.categoria);
    if(l.serie)meta+=' · Parcela '+l.serie.parcela+'/'+l.serie.total;
    if(l.virtual)meta+=' · Fixa';
    var m=document.createElement('span');m.className='m';m.textContent=meta;
    txt.appendChild(d);txt.appendChild(m);
    var v=document.createElement('span');v.className='v';v.textContent=(l.tipo==='renda'?'+ ':'− ')+brl(l.valorCentavos);
    var sr=document.createElement('span');sr.className='sr';sr.textContent=l.tipo==='renda'?', entrada. Toque para editar.':', saída. Toque para editar.';
    b.appendChild(txt);b.appendChild(v);b.appendChild(sr);
    b.addEventListener('click',function(){abrirForm(l);});
    li.appendChild(b);ul.appendChild(li);
  });
  var fi=$('#finfo');
  if(filtro&&itens.length){
    var soma=itens.reduce(function(s,l){return s+l.valorCentavos;},0);
    fi.hidden=false;fi.textContent=plural(itens.length,'lançamento','lançamentos')+' neste filtro · '+brl(soma);
  }else{fi.hidden=true;fi.textContent='';}
  var vz=$('#vazio');
  if(itens.length){vz.hidden=true;return;}
  vz.hidden=false;
  if(!doM.length){$('#vazio-t').textContent='Nenhum lançamento';$('#vazio-p').textContent='Toque em + Adicionar para registrar o primeiro gasto ou a renda de '+mesLabel(mes).toLowerCase()+'.';}
  else{$('#vazio-t').textContent='Nada neste filtro';$('#vazio-p').textContent='Escolha "Todos" para ver os '+plural(doM.length,'lançamento','lançamentos')+' do mês.';}
}

function renderFixas(){
  var ul=$('#fixas');ul.textContent='';
  var atual=hoje().slice(0,7);
  var ativas=state.fixas.filter(function(f){return !f.fim||f.fim>=atual;});
  $('#fixas-vazio').hidden=ativas.length>0;
  ativas.slice().sort(function(a,b){return a.dia-b.dia;}).forEach(function(f){
    var li=document.createElement('li');
    var info=document.createElement('div');
    var n=document.createElement('span');n.className='n';n.textContent=f.descricao;
    var s=document.createElement('small');
    s.textContent='Todo dia '+f.dia+' · '+(f.tipo==='renda'?'Renda':f.categoria)+' · desde '+mesLabel(f.inicio).toLowerCase()+(f.fim?' · até '+mesLabel(f.fim).toLowerCase():'');
    info.appendChild(n);info.appendChild(s);
    var v=document.createElement('span');v.className='v';v.textContent=(f.tipo==='renda'?'+ ':'− ')+brl(f.valorCentavos);
    li.appendChild(info);li.appendChild(v);ul.appendChild(li);
  });
}

function renderCats(){
  var ul=$('#cats');ul.textContent='';
  catsOrdenadas().forEach(function(c){
    var li=document.createElement('li');
    var info=document.createElement('div');
    var n=document.createElement('span');n.className='n';n.textContent=c;
    var s=document.createElement('small');var q=contarGastos(c);s.textContent=c==='Outros'?'Padrão · '+plural(q,'gasto','gastos'):plural(q,'gasto','gastos');
    info.appendChild(n);info.appendChild(s);li.appendChild(info);
    if(c!=='Outros'){
      var acts=document.createElement('div');acts.className='acts';
      var r=document.createElement('button');r.type='button';r.className='btn sm';r.textContent='Renomear';r.setAttribute('aria-label','Renomear '+c);
      r.addEventListener('click',function(){renomearCat(c,r);});
      var x=document.createElement('button');x.type='button';x.className='btn sm ghost-danger';x.textContent='Excluir';x.setAttribute('aria-label','Excluir '+c);
      x.addEventListener('click',function(){excluirCat(c,x);});
      acts.appendChild(r);acts.appendChild(x);li.appendChild(acts);
    }
    ul.appendChild(li);
  });
}

/* ---------- Formulário de lançamento ---------- */
var form=$('#form'),fDesc=$('#f-desc'),fValor=$('#f-valor'),fData=$('#f-data'),fCat=$('#f-cat'),fNova=$('#f-nova'),fParc=$('#f-parc');
var editItem=null;
function tipoAtual(){return form.querySelector('input[name="tipo"]:checked').value;}
function repAtual(){return form.querySelector('input[name="rep"]:checked').value;}
function preencherCats(valor){
  fCat.textContent='';
  catsOrdenadas().forEach(function(c){fCat.appendChild(new Option(c,c));});
  fCat.appendChild(new Option('+ Nova categoria…','__nova'));
  fCat.value=valor&&state.categorias.indexOf(valor)>=0?valor:'Outros';
}
function atualizarTipo(){
  var g=tipoAtual()==='gasto';
  $('#cat-field').hidden=!g;
  fDesc.placeholder=g?'Ex.: Mercado, Uber, Aluguel':'Ex.: Salário, Job';
  var rp=$('#r-parc');
  rp.disabled=!g;
  if(!g&&rp.checked)$('#r-unica').checked=true;
  atualizarRep();
}
function atualizarRep(){
  var hint=$('#rep-hint');
  if(editItem){$('#parc-wrap').hidden=true;hint.hidden=true;$('#lbl-valor').textContent=editItem.serie?'Valor da parcela (R$)':'Valor (R$)';return;}
  var r=repAtual();
  $('#parc-wrap').hidden=r!=='parcelada';
  $('#lbl-valor').textContent=r==='parcelada'?'Valor da parcela (R$)':'Valor (R$)';
  var data=dataValida(fData.value)?fData.value:null;
  if(r==='parcelada'){
    var n=/^\d+$/.test(fParc.value.trim())?parseInt(fParc.value,10):0,c=parseValor(fValor.value);
    var t='Uma parcela por mês, no mesmo dia, a partir da data escolhida.';
    if(n>=2&&n<=72&&c&&data)t=n+'× '+brl(c)+' = '+brl(n*c)+' · de '+mesLabel(data.slice(0,7)).toLowerCase()+' a '+mesLabel(dataNoMes(data,n-1).slice(0,7)).toLowerCase()+'.';
    hint.textContent=t;hint.hidden=false;
  }else if(r==='fixa'){
    var dia=data?Number(data.slice(8)):null;
    hint.textContent=dia?'Repete todo mês no dia '+dia+', até você encerrar.'+(dia>28?' Em meses mais curtos, cai no último dia.':''):'Repete todo mês no dia da data escolhida, até você encerrar.';
    hint.hidden=false;
  }else{hint.hidden=true;hint.textContent='';}
}
function limparErros(){
  ['e-desc','e-valor','e-data','e-cat','e-parc'].forEach(function(id){$('#'+id).textContent='';});
  [fDesc,fValor,fData,fCat,fNova,fParc].forEach(function(el){el.removeAttribute('aria-invalid');});
}
function abrirForm(item){
  if(bloqueado())return;
  editItem=item||null;
  limparErros();
  $('#sheet-title').textContent=item?(item.virtual?'Editar conta fixa':item.serie?'Editar parcela':'Editar lançamento'):'Novo lançamento';
  form.querySelector('input[name="tipo"][value="'+(item?item.tipo:'gasto')+'"]').checked=true;
  var serie=!!(item&&(item.virtual||item.serie));
  form.querySelectorAll('input[name="tipo"]').forEach(function(r){r.disabled=serie;});
  $('#r-unica').checked=true;fParc.value='';
  $('#rep-wrap').hidden=!!item;
  var info=$('#serie-info');
  if(item&&item.serie){info.hidden=false;info.textContent='Parcela '+item.serie.parcela+' de '+item.serie.total+'.';}
  else if(item&&item.virtual){var f=acharFixa(item.fixaId);info.hidden=false;info.textContent='Conta fixa desde '+mesLabel(f.inicio).toLowerCase()+'. Você está vendo '+mesLabel(item.mesRef).toLowerCase()+'.';}
  else{info.hidden=true;info.textContent='';}
  fDesc.value=item?item.descricao:'';
  fValor.value=item?centsParaCampo(item.valorCentavos):'';
  fData.value=item?item.data:(mes===hoje().slice(0,7)?hoje():mes+'-01');
  preencherCats(item&&item.categoria);
  catTocada=!!item;catAuto=false;
  $('#h-cat').hidden=true;$('#nova-wrap').hidden=true;fNova.value='';
  $('#btn-del').hidden=!item;
  $('#btn-del').textContent=item&&item.virtual?'Excluir ou encerrar conta fixa':item&&item.serie?'Excluir parcela':'Excluir lançamento';
  atualizarTipo();
  abrirCamada($('#sheet'),fDesc);
}
function fecharForm(){fecharCamada();}

form.querySelectorAll('input[name="tipo"]').forEach(function(r){r.addEventListener('change',atualizarTipo);});
form.querySelectorAll('input[name="rep"]').forEach(function(r){r.addEventListener('change',atualizarRep);});
[fValor,fData,fParc].forEach(function(el){el.addEventListener('input',atualizarRep);});
fDesc.addEventListener('input',function(){
  if(tipoAtual()!=='gasto'||catTocada)return;
  var s=sugerir(fDesc.value);
  if(s){fCat.value=s;catAuto=true;$('#h-cat').hidden=false;}
  else if(catAuto){fCat.value='Outros';catAuto=false;$('#h-cat').hidden=true;}
});
fCat.addEventListener('change',function(){
  catTocada=true;$('#h-cat').hidden=true;
  var nova=fCat.value==='__nova';
  $('#nova-wrap').hidden=!nova;
  if(nova)setTimeout(function(){fNova.focus();},30);
});
$('#btn-cancel').addEventListener('click',fecharForm);

function garantirCat(d){if(d.tipo==='gasto'&&state.categorias.indexOf(d.categoria)<0)state.categorias.push(d.categoria);}
/* Salva, aprende a categoria, fecha o painel e mostra o mês do lançamento */
function concluir(d,msg){
  garantirCat(d);
  if(d.tipo==='gasto')aprender(d.descricao,d.categoria);
  var extra=verificarAlertas([d.data.slice(0,7),hoje().slice(0,7)]);
  if(extra)msg+=' '+extra;
  var ok=salvar();
  var km=d.data.slice(0,7);
  if(km!==mes){mes=km;msg+=' Mostrando '+mesLabel(km)+'.';}
  fecharCamada($('#fab'));
  render();
  if(ok)anunciar(msg);
}
function aplicarEm(l,d){l.descricao=d.descricao;l.valorCentavos=d.valorCentavos;l.categoria=d.categoria;}

form.addEventListener('submit',function(e){
  e.preventDefault();
  if(bloqueado())return;
  limparErros();
  var primeiro=null;
  function erro(el,id,msg){$('#'+id).textContent=msg;el.setAttribute('aria-invalid','true');if(!primeiro)primeiro=el;}
  var tipo=tipoAtual(),rep=editItem?'unica':repAtual();
  var desc=fDesc.value.trim().replace(/\s+/g,' ');
  var cents=parseValor(fValor.value);
  var data=fData.value;
  var cat=null,nParc=0;
  if(!desc)erro(fDesc,'e-desc','Descreva o lançamento.');
  if(cents===null)erro(fValor,'e-valor','Informe um valor válido, como 12,50.');
  else if(cents<=0)erro(fValor,'e-valor','Informe um valor maior que zero.');
  if(!dataValida(data))erro(fData,'e-data','Informe uma data válida.');
  else if(editItem&&editItem.virtual&&data.slice(0,7)!==editItem.mesRef)erro(fData,'e-data','Numa conta fixa, a data precisa ficar em '+mesLabel(editItem.mesRef).toLowerCase()+'.');
  if(rep==='parcelada'){
    var tx=fParc.value.trim();nParc=/^\d+$/.test(tx)?parseInt(tx,10):0;
    if(nParc<2||nParc>72)erro(fParc,'e-parc','Informe de 2 a 72 parcelas.');
  }
  if(tipo==='gasto'){
    if(fCat.value==='__nova'){
      var nome=fNova.value.trim().replace(/\s+/g,' ');
      if(!nome)erro(fNova,'e-cat','Digite o nome da nova categoria.');
      else cat=acharCat(nome)||nome;
    }else if(state.categorias.indexOf(fCat.value)>=0)cat=fCat.value;
    else erro(fCat,'e-cat','Escolha uma categoria.');
  }
  if(primeiro){primeiro.focus();anunciar('Confira os campos destacados.');return;}

  var d={tipo:tipo,descricao:desc,valorCentavos:cents,data:data,categoria:tipo==='gasto'?cat:null};
  var agora=new Date().toISOString();

  /* Novo lançamento */
  if(!editItem){
    if(rep==='fixa'){
      state.fixas.push({id:novoId(),tipo:tipo,descricao:desc,valorCentavos:cents,categoria:d.categoria,dia:Number(data.slice(8)),inicio:data.slice(0,7),fim:null,excecoes:{},criadoEm:agora});
      concluir(d,(tipo==='gasto'?'Conta fixa':'Renda fixa')+' adicionada. Ela aparece todo mês.');
    }else if(rep==='parcelada'){
      var sid=novoId();
      for(var i=0;i<nParc;i++)state.lancamentos.push({id:novoId(),tipo:'gasto',data:dataNoMes(data,i),descricao:desc,valorCentavos:cents,categoria:d.categoria,criadoEm:agora,serie:{id:sid,parcela:i+1,total:nParc}});
      concluir(d,nParc+' parcelas adicionadas, até '+mesLabel(dataNoMes(data,nParc-1).slice(0,7)).toLowerCase()+'.');
    }else{
      state.lancamentos.push({id:novoId(),tipo:tipo,data:data,descricao:desc,valorCentavos:cents,categoria:d.categoria,criadoEm:agora});
      concluir(d,tipo==='gasto'?'Gasto adicionado.':'Renda adicionada.');
    }
    return;
  }

  /* Edição de uma conta fixa */
  if(editItem.virtual){
    var f=acharFixa(editItem.fixaId),k=editItem.mesRef;
    if(!f){fecharForm();render();anunciar('Esta conta fixa não existe mais.');return;}
    abrirDialogo({titulo:'Alterar conta fixa',corpo:'Aplicar a mudança só em '+mesLabel(k).toLowerCase()+' ou também nos meses seguintes?',acoes:[
      cancelar(),
      {rotulo:'Só neste mês',run:function(){
        f.excecoes[k]={descricao:desc,valorCentavos:cents,data:data,categoria:d.categoria};
        return function(){concluir(d,'Alterado só em '+mesLabel(k).toLowerCase()+'.');};
      }},
      {rotulo:'Este mês e os próximos',tipo:'primary',run:function(){
        Object.keys(f.excecoes).forEach(function(m){if(m>=k)delete f.excecoes[m];});
        if(k<=f.inicio){f.descricao=desc;f.valorCentavos=cents;f.categoria=d.categoria;f.dia=Number(data.slice(8));}
        else{
          f.fim=addMes(k,-1);
          state.fixas.push({id:novoId(),tipo:f.tipo,descricao:desc,valorCentavos:cents,categoria:d.categoria,dia:Number(data.slice(8)),inicio:k,fim:null,excecoes:{},criadoEm:agora});
        }
        return function(){concluir(d,'Conta fixa atualizada a partir de '+mesLabel(k).toLowerCase()+'.');};
      }}
    ]});
    return;
  }

  var l=state.lancamentos.filter(function(x){return x.id===editItem.id;})[0];
  if(!l){fecharForm();render();anunciar('Este lançamento não existe mais.');return;}

  /* Edição de uma parcela */
  if(l.serie){
    var s=l.serie,restantes=s.total-s.parcela+1;
    abrirDialogo({titulo:'Alterar parcelas',corpo:'Esta é a parcela '+s.parcela+' de '+s.total+'. Aplicar a mudança em quais parcelas?',acoes:[
      cancelar(),
      {rotulo:'Só esta parcela',run:function(){
        aplicarEm(l,d);l.data=data;
        return function(){concluir(d,'Parcela '+s.parcela+' atualizada.');};
      }},
      {rotulo:restantes>1?'Esta e as '+(restantes-1)+' seguintes':'Esta parcela (é a última)',tipo:'primary',run:function(){
        state.lancamentos.forEach(function(x){
          if(x.serie&&x.serie.id===s.id&&x.serie.parcela>=s.parcela){aplicarEm(x,d);x.data=dataNoMes(data,x.serie.parcela-s.parcela);}
        });
        return function(){concluir(d,plural(restantes,'parcela atualizada','parcelas atualizadas')+'.');};
      }}
    ]});
    return;
  }

  /* Edição simples */
  l.tipo=tipo;aplicarEm(l,d);l.data=data;
  concluir(d,'Lançamento atualizado.');
});

function depoisDeExcluir(msg,ok){return function(){fecharCamada($('#fab'));render();if(ok)anunciar(msg);};}
$('#btn-del').addEventListener('click',function(){
  var it=editItem;if(!it)return;
  if(it.virtual){
    var f=acharFixa(it.fixaId),k=it.mesRef;if(!f)return;
    var acoes=[cancelar(),{rotulo:'Só em '+mesLabel(k).toLowerCase(),run:function(){
      f.excecoes[k]={removido:true};
      return depoisDeExcluir('Removida só de '+mesLabel(k).toLowerCase()+'.',salvar());
    }}];
    if(k>f.inicio){
      acoes.push({rotulo:'Encerrar a partir deste mês',tipo:'danger',run:function(){
        f.fim=addMes(k,-1);
        Object.keys(f.excecoes).forEach(function(m){if(m>=k)delete f.excecoes[m];});
        return depoisDeExcluir('Conta fixa encerrada. Os meses anteriores continuam no histórico.',salvar());
      }});
    }else{
      acoes.push({rotulo:'Excluir a conta fixa inteira',tipo:'danger',run:function(){
        state.fixas=state.fixas.filter(function(x){return x.id!==f.id;});
        return depoisDeExcluir('Conta fixa excluída.',salvar());
      }});
    }
    abrirDialogo({titulo:'Excluir conta fixa?',
      corpo:'"'+it.descricao+'" se repete todo mês desde '+mesLabel(f.inicio).toLowerCase()+'.'+(k>f.inicio?' Ao encerrar, os meses anteriores a '+mesLabel(k).toLowerCase()+' continuam no histórico.':'')+' Esta ação não pode ser desfeita.',
      acoes:acoes});
    return;
  }
  var l=state.lancamentos.filter(function(x){return x.id===it.id;})[0];
  if(!l)return;
  if(l.serie){
    var s=l.serie;
    var daSerie=function(x){return x.serie&&x.serie.id===s.id;};
    var nSeg=state.lancamentos.filter(function(x){return daSerie(x)&&x.serie.parcela>=s.parcela;}).length;
    var nTodas=state.lancamentos.filter(daSerie).length;
    var acoes2=[cancelar(),{rotulo:'Só esta parcela',run:function(){
      state.lancamentos=state.lancamentos.filter(function(x){return x.id!==l.id;});
      return depoisDeExcluir('Parcela '+s.parcela+' excluída.',salvar());
    }}];
    if(nSeg>1)acoes2.push({rotulo:'Esta e as seguintes ('+nSeg+')',tipo:'danger',run:function(){
      state.lancamentos=state.lancamentos.filter(function(x){return !(daSerie(x)&&x.serie.parcela>=s.parcela);});
      return depoisDeExcluir(nSeg+' parcelas excluídas.',salvar());
    }});
    if(nTodas>nSeg)acoes2.push({rotulo:'Todas as parcelas ('+nTodas+')',tipo:'danger',run:function(){
      state.lancamentos=state.lancamentos.filter(function(x){return !daSerie(x);});
      return depoisDeExcluir(nTodas+' parcelas excluídas.',salvar());
    }});
    abrirDialogo({titulo:'Excluir parcela?',corpo:'"'+l.descricao+'", parcela '+s.parcela+' de '+s.total+'. Esta ação não pode ser desfeita.',acoes:acoes2});
    return;
  }
  abrirDialogo({
    titulo:'Excluir lançamento?',
    corpo:'Excluir "'+l.descricao+'" – '+brl(l.valorCentavos)+'? Esta ação não pode ser desfeita.',
    acoes:[cancelar(),{rotulo:'Excluir',tipo:'danger',run:function(){
      state.lancamentos=state.lancamentos.filter(function(x){return x.id!==l.id;});
      return depoisDeExcluir('Lançamento excluído.',salvar());
    }}]
  });
});

/* ---------- Categorias em Ajustes ---------- */
$('#cat-add').addEventListener('submit',function(e){
  e.preventDefault();
  if(bloqueado())return;
  var inp=$('#cat-nova'),er=$('#e-cat-nova');
  var nome=inp.value.trim().replace(/\s+/g,' ');
  er.textContent='';inp.removeAttribute('aria-invalid');
  if(!nome){er.textContent='Digite o nome da categoria.';inp.setAttribute('aria-invalid','true');inp.focus();return;}
  if(acharCat(nome)){er.textContent='Já existe uma categoria com esse nome.';inp.setAttribute('aria-invalid','true');inp.focus();return;}
  state.categorias.push(nome);
  var ok=salvar();inp.value='';render();
  if(ok)anunciar('Categoria "'+nome+'" criada.');
});

function renomearCat(c,botao){
  if(bloqueado())return;
  var wrap=document.createElement('div');wrap.className='field';
  var lb=document.createElement('label');lb.setAttribute('for','dlg-nome');lb.textContent='Novo nome';
  var inp=document.createElement('input');inp.id='dlg-nome';inp.maxLength=30;inp.value=c;inp.autocomplete='off';inp.setAttribute('aria-describedby','dlg-nome-e');
  var er=document.createElement('p');er.className='err';er.id='dlg-nome-e';
  wrap.appendChild(lb);wrap.appendChild(inp);wrap.appendChild(er);
  abrirDialogo({titulo:'Renomear categoria',corpo:wrap,foco:inp,focoDepois:botao,acoes:[cancelar(),{rotulo:'Salvar',tipo:'primary',run:function(){
    var nome=inp.value.trim().replace(/\s+/g,' ');
    if(!nome){er.textContent='Digite um nome.';inp.setAttribute('aria-invalid','true');inp.focus();return false;}
    if(nome===c)return true;
    var ex=acharCat(nome);
    if(ex&&ex!==c){return function(){juntarCat(c,ex);};}
    moverCategoria(c,nome,false);
    var ok=salvar();
    return function(){render();if(ok)anunciar('Categoria renomeada para "'+nome+'".');};
  }}]});
}
function juntarCat(de,para){
  var n=contarGastos(de);
  abrirDialogo({titulo:'Juntar categorias?',
    corpo:'Já existe "'+para+'". Juntar "'+de+'" em "'+para+'"? '+(n?'Os '+plural(n,'gasto','gastos')+' de "'+de+'" passam para "'+para+'".':'"'+de+'" não tem gastos.'),
    acoes:[cancelar(),{rotulo:'Juntar',tipo:'primary',run:function(){
      moverCategoria(de,para,true);var ok=salvar();
      return function(){render();if(ok)anunciar('"'+de+'" foi juntada a "'+para+'".');};
    }}]});
}
function excluirCat(c,botao){
  if(bloqueado())return;
  var n=contarGastos(c);
  if(!n){
    abrirDialogo({titulo:'Excluir categoria?',corpo:'Excluir a categoria "'+c+'"? Ela não tem gastos.',acoes:[cancelar(),{rotulo:'Excluir',tipo:'danger',run:function(){
      moverCategoria(c,'Outros',true);var ok=salvar();
      return function(){render();if(ok)anunciar('Categoria "'+c+'" excluída.');};
    }}]});
    return;
  }
  var wrap=document.createElement('div');wrap.style.display='flex';wrap.style.flexDirection='column';wrap.style.gap='12px';
  var p=document.createElement('p');p.textContent='"'+c+'" tem '+plural(n,'gasto','gastos')+'. Escolha para onde eles vão antes de excluir.';
  var f=document.createElement('div');f.className='field';
  var lb=document.createElement('label');lb.setAttribute('for','dlg-dest');lb.textContent='Mover gastos para';
  var sel=document.createElement('select');sel.id='dlg-dest';
  catsOrdenadas().filter(function(x){return x!==c;}).forEach(function(x){sel.appendChild(new Option(x,x));});
  sel.value='Outros';
  f.appendChild(lb);f.appendChild(sel);wrap.appendChild(p);wrap.appendChild(f);
  abrirDialogo({titulo:'Excluir categoria?',corpo:wrap,foco:sel,focoDepois:botao,acoes:[cancelar(),{rotulo:'Mover e excluir',tipo:'danger',run:function(){
    var dest=sel.value;moverCategoria(c,dest,true);var ok=salvar();
    return function(){render();if(ok)anunciar(plural(n,'gasto movido','gastos movidos')+' para "'+dest+'". Categoria "'+c+'" excluída.');};
  }}]});
}

/* ---------- Navegação ---------- */
$('#mes-ant').addEventListener('click',function(){mes=addMes(mes,-1);render();});
$('#mes-prox').addEventListener('click',function(){mes=addMes(mes,1);render();});
$('#filtro').addEventListener('change',function(e){filtro=e.target.value;renderLista();});
$('#fab').addEventListener('click',function(){abrirForm(null);});
function irPara(v){
  ['lanc','res','inv','aj'].forEach(function(n){
    $('#view-'+n).hidden=n!==v;
    if(n===v)$('#tab-'+n).setAttribute('aria-current','page');else $('#tab-'+n).removeAttribute('aria-current');
  });
  $('#fab').hidden=v!=='lanc';
  window.scrollTo(0,0);
}
$('#tab-lanc').addEventListener('click',function(){irPara('lanc');});
$('#tab-res').addEventListener('click',function(){irPara('res');});
$('#tab-inv').addEventListener('click',function(){irPara('inv');});
$('#tab-aj').addEventListener('click',function(){irPara('aj');});

render();
if(retornoLogin&&retornoLogin.erro){anunciar('Não foi possível entrar com Google: '+retornoLogin.erro);}
else if(retornoLogin&&PUBLICADO){concluirLogin(retornoLogin);}
else if(sessao){sincronizar();}
window.addEventListener('online',function(){sincronizar();});
window.addEventListener('offline',function(){if(sessao)setSync('offline');});
document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible')sincronizar();});

var instalado=(window.matchMedia&&matchMedia('(display-mode: standalone)').matches)||navigator.standalone===true;
if(instalado){$('#instalado-txt').hidden=false;$('#instalar-passos').hidden=true;}
/* Instalação: registra o service worker só quando o app está publicado com o manifesto */
if('serviceWorker' in navigator&&document.querySelector('link[rel="manifest"]')&&location.protocol==='https:'){
  window.addEventListener('load',function(){navigator.serviceWorker.register('sw.js').catch(function(){});});
}
})();
