"use strict";
window.CategoryModule = {
  render({ root, items, user, api, reload }) {
    const el = (tag, text, cls) => { const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n; };
    const card=el('section',undefined,'card'),header=el('div',undefined,'card-header');header.append(el('h2','Categorias'),el('small',`${items.length} categoria(s)`));card.append(header);
    const wrap=el('div',undefined,'table-wrap'),table=el('table'),head=el('thead'),headRow=el('tr'),body=el('tbody');
    for(const label of ['Nome','Slug','Matérias','Estado','Ações']){const th=el('th',label);th.scope='col';headRow.append(th);}head.append(headRow);
    const feedback=el('p',undefined,'save-status');feedback.setAttribute('role','status');
    for(const category of items){const row=el('tr'),actions=el('td');if(user.permissions.includes('categories.edit')){const edit=el('button','Editar','secondary');edit.type='button';edit.addEventListener('click',()=>openEdit(category,edit));actions.append(edit);}if(user.permissions.includes('categories.delete')){const remove=el('button','Excluir','secondary danger');remove.type='button';remove.addEventListener('click',()=>open(category,remove));actions.append(remove);}if(!actions.children.length)actions.textContent='—';row.append(el('td',category.name),el('td',category.slug),el('td',String(category.newsCount??0)),el('td',category.isActive?'Ativa':'Inativa'),actions);body.append(row);}
    table.append(head,body);wrap.append(table);card.append(wrap);root.replaceChildren(feedback,card);
    function openEdit(category,opener){
      const dialog=el('dialog',undefined,'category-delete-dialog'),form=el('form');dialog.setAttribute('aria-labelledby','category-edit-title');
      const title=el('h2','Editar categoria');title.id='category-edit-title';
      const label=el('label','Nome da categoria');label.htmlFor='category-edit-name';const name=el('input');name.id=label.htmlFor;name.value=category.name;name.required=true;name.maxLength=120;name.autocomplete='off';
      const slugLabel=el('label','Slug gerado automaticamente');slugLabel.htmlFor='category-edit-slug';const slug=el('input');slug.id=slugLabel.htmlFor;slug.value=category.slug;slug.readOnly=true;
      const slugify=value=>value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');name.addEventListener('input',()=>{slug.value=slugify(name.value.trim());});
      const error=el('p',undefined,'error');error.setAttribute('role','alert');const controls=el('div',undefined,'category-dialog-actions'),cancel=el('button','Cancelar','secondary'),save=el('button','Salvar alterações','primary');cancel.type='button';save.type='submit';controls.append(cancel,save);
      form.append(title,label,name,slugLabel,slug,el('p','As matérias continuam vinculadas à categoria.','muted'),error,controls);dialog.append(form);root.append(dialog);
      let submitting=false;cancel.addEventListener('click',()=>dialog.close());dialog.addEventListener('cancel',event=>{if(submitting)event.preventDefault();});dialog.addEventListener('close',()=>{dialog.remove();opener.focus();});
      form.addEventListener('submit',async event=>{event.preventDefault();if(submitting||!form.reportValidity())return;if(!slug.value){error.textContent='Informe um nome com letras ou números para gerar o slug.';return;}submitting=true;save.disabled=true;cancel.disabled=true;name.disabled=true;save.textContent='Salvando…';error.textContent='';
        try{await api(`categories/${category.id}`,{method:'PUT',body:JSON.stringify({name:name.value.trim()})});dialog.close();await reload();const message=root.querySelector('[role="status"]');if(message)message.textContent='Categoria atualizada com sucesso.';}
        catch(e){error.textContent=e.message;submitting=false;save.disabled=false;cancel.disabled=false;name.disabled=false;save.textContent='Salvar alterações';}
      });dialog.showModal();name.focus();
    }
    function open(category,opener){
      const dialog=el('dialog',undefined,'category-delete-dialog'),form=el('form');dialog.setAttribute('aria-labelledby','category-delete-title');
      const title=el('h2',`Excluir ${category.name}?`);title.id='category-delete-title';form.append(title,el('p','A exclusão da categoria é definitiva. As matérias serão preservadas.','muted'));
      const count=category.newsCount??0,destinations=items.filter(c=>c.id!==category.id&&c.isActive),canTransfer=user.permissions.includes('categories.transfer');
      const select=el('select');select.id='category-delete-target';const empty=el('option','Selecione uma categoria de destino');empty.value='';select.append(empty);
      for(const destination of destinations){const option=el('option',destination.name);option.value=destination.id;select.append(option);}
      if(count){form.append(el('p',`${count} matéria(s) serão transferidas, incluindo publicadas, rascunhos, agendadas e arquivadas.`));const label=el('label','Transferir matérias para');label.htmlFor=select.id;form.append(label,select);select.required=true;}
      const error=el('p',undefined,'error');error.setAttribute('role','alert');const controls=el('div',undefined,'category-dialog-actions'),cancel=el('button','Cancelar','secondary'),confirm=el('button',count?'Transferir e excluir':'Excluir categoria','primary');cancel.type='button';confirm.type='submit';controls.append(cancel,confirm);form.append(error,controls);
      if(category.childrenCount){error.textContent='Esta categoria tem subcategorias. Reorganize ou exclua as subcategorias antes.';confirm.disabled=true;}
      else if(count&&(!canTransfer||!destinations.length)){error.textContent=!canTransfer?'Sua conta não tem permissão para transferir matérias.':'Não há outra categoria ativa para receber as matérias.';confirm.disabled=true;}
      let submitting=false;cancel.addEventListener('click',()=>dialog.close());dialog.addEventListener('cancel',event=>{if(submitting)event.preventDefault();});dialog.addEventListener('close',()=>{dialog.remove();opener.focus();});
      form.addEventListener('submit',async event=>{event.preventDefault();if(submitting||confirm.disabled||!form.reportValidity())return;submitting=true;confirm.disabled=true;cancel.disabled=true;select.disabled=true;error.textContent='';confirm.textContent='Processando…';
        try{const result=await api(`categories/${category.id}`,{method:'DELETE',body:JSON.stringify({targetId:count?select.value:null})});dialog.close();await reload();const message=root.querySelector('[role="status"]');if(message)message.textContent=`Categoria excluída. ${result.moved} matéria(s) transferida(s).`;}
        catch(e){error.textContent=e.message;submitting=false;confirm.disabled=false;cancel.disabled=false;select.disabled=false;confirm.textContent=count?'Transferir e excluir':'Excluir categoria';}
      });dialog.append(form);root.append(dialog);dialog.showModal();
    }
  },
};

