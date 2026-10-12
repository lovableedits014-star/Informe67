"use strict";
window.UserModule = { render({root,items,user,api,reload}) {
  const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  const labels={superadministrator:'Superadministrador',administrator:'Administrador',editor:'Editor',reader:'Leitor'};
  const feedback=el('p',undefined,'save-status');feedback.role='status';
  const card=el('section',undefined,'card'),header=el('div',undefined,'card-header');header.append(el('h2','Usuários da equipe'));
  if(user.permissions.includes('users.create')&&user.roles?.includes('superadministrator')) {
    const add=el('button','Novo usuário','secondary');add.type='button';add.onclick=()=>create();header.append(add);
  }
  card.append(header);
  const wrap=el('div',undefined,'table-wrap'),table=el('table'),thead=el('thead'),head=el('tr'),body=el('tbody');
  for(const title of ['Nome','E-mail','Perfil','Ativo']){const th=el('th',title);th.scope='col';head.append(th);}thead.append(head);
  for(const item of items){const row=el('tr');for(const value of [item.displayName,item.email,(item.roles||[]).map(r=>labels[r]||r).join(', '),item.isActive?'Sim':'Não'])row.append(el('td',value));body.append(row);}
  table.append(thead,body);wrap.append(table);card.append(wrap);root.replaceChildren(feedback,card);
  async function create(){
    const form=el('form',undefined,'card banner-form');
    form.innerHTML=`<div class="card-body"><h2>Novo usuário</h2><label>Nome<input name="displayName" autocomplete="name" maxlength="160" required></label><label>E-mail<input name="email" type="email" autocomplete="off" maxlength="320" required></label><label>Perfil<select name="role" required disabled><option value="">Carregando perfis…</option></select></label><p class="muted" id="user-profile-description"></p><label>Senha · mínimo 12 caracteres<input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="1024" required></label><label>Confirmar senha<input name="confirmPassword" type="password" autocomplete="new-password" minlength="12" maxlength="1024" required></label><p class="error" role="alert"></p><div class="category-dialog-actions"><button type="button" class="secondary" id="user-cancel">Cancelar</button><button type="submit" class="primary" disabled>Cadastrar usuário</button></div></div>`;
    root.replaceChildren(feedback,form);const field=name=>form.elements.namedItem(name),error=form.querySelector('[role="alert"]'),submit=form.querySelector('[type="submit"]');let busy=false;
    const clearPasswords=()=>{field('password').value='';field('confirmPassword').value='';};
    form.querySelector('#user-cancel').onclick=()=>{if(!busy){clearPasswords();window.UserModule.render({root,items,user,api,reload});}};
    try{const {items:profiles}=await api('users/profiles');if(!form.isConnected)return;field('role').replaceChildren();for(const profile of profiles){const option=el('option',profile.label);option.value=profile.name;field('role').append(option);}field('role').value='editor';field('role').disabled=false;submit.disabled=false;const describe=()=>{form.querySelector('#user-profile-description').textContent=profiles.find(p=>p.name===field('role').value)?.description||'';};field('role').onchange=describe;describe();}catch(e){error.textContent=e.message;}
    form.onsubmit=async event=>{event.preventDefault();if(busy||submit.disabled||!form.reportValidity())return;if(field('password').value!==field('confirmPassword').value){error.textContent='As senhas não coincidem.';return;}busy=true;submit.disabled=true;submit.textContent='Cadastrando…';error.textContent='';
      try{await api('users',{method:'POST',body:JSON.stringify({displayName:field('displayName').value,email:field('email').value,password:field('password').value,role:field('role').value})});clearPasswords();await reload();const status=root.querySelector('[role="status"]');if(status)status.textContent='Usuário cadastrado. Já pode entrar no painel com o perfil escolhido.';}
      catch(e){error.textContent=e.message;clearPasswords();}finally{busy=false;submit.disabled=false;submit.textContent='Cadastrar usuário';}
    };
  }
}};
