// Согласие на обработку персональных данных (152-ФЗ): у ученика спрашиваем один раз — на доске или в кабинете.
// Ответ хранится на сервере (/api/<id>/consent), поэтому на другом устройстве второй раз не спросим.
// Если ученику нет 18 лет, согласие даёт родитель — об этом написано в окне.
window.pdGate = function (id) {
  if (!id || window.pdGateOn) return;
  window.pdGateOn = true;
  fetch('/api/' + id + '/consent').then(r => r.ok ? r.json() : { ok: true }).then(j => {
    if (j.ok) return;
    const st = document.createElement('style');
    st.textContent = '#pdg{position:fixed;inset:0;z-index:2147483000;background:rgba(20,24,36,.55);display:flex;align-items:center;justify-content:center;padding:16px;font:15px/1.45 -apple-system,"Segoe UI",Roboto,sans-serif}'
      + '#pdg .pdb{background:#fffdf8;color:#1b2233;max-width:440px;width:100%;max-height:100%;overflow:auto;border-radius:16px;padding:20px;box-shadow:0 10px 40px rgba(0,0,0,.3)}'
      + '#pdg h3{margin:0 0 8px;font-size:19px}#pdg p{margin:0 0 12px}#pdg a{color:#2547b0}'
      + '#pdg label{display:flex;gap:9px;align-items:flex-start;margin:9px 0;cursor:pointer}#pdg input{margin-top:3px;width:18px;height:18px;flex:none}'
      + '#pdg .rk{border:1px solid #e4dfd2;border-radius:10px;padding:8px 10px;margin:6px 0}'
      + '#pdg button{margin-top:10px;width:100%;font:inherit;font-weight:700;padding:11px;border-radius:10px;border:0;background:#2547b0;color:#fff;cursor:pointer}#pdg button:disabled{opacity:.45;cursor:default}'
      + '#pdg .er{color:#d33a2c;font-size:13px;margin-top:6px}';
    document.head.appendChild(st);
    const o = document.createElement('div');
    o.id = 'pdg';
    o.innerHTML = '<div class="pdb" role="dialog" aria-modal="true" aria-labelledby="pdh"><h3 id="pdh">Согласие на обработку данных</h3>'
      + '<p>На доске и в кабинете хранятся имя ученика, записи на доске, домашки и фото решений. По закону (152-ФЗ) для этого нужно согласие. <b>Если ученику нет 18 лет, согласие даёт родитель.</b></p>'
      + '<p style="margin:0">Кто вы?</p>'
      + '<label class="rk"><input type="radio" name="pdw" value="parent"> Я родитель (законный представитель) ученика</label>'
      + '<label class="rk"><input type="radio" name="pdw" value="adult"> Я ученик, мне уже есть 18 лет</label>'
      + '<label><input type="checkbox" id="pdc"> <span>Даю <a href="/consent" target="_blank">согласие на обработку персональных данных</a> и ознакомлен(а) с <a href="/privacy" target="_blank">политикой конфиденциальности</a></span></label>'
      + '<button id="pdok" disabled>Продолжить</button><div class="er" id="pder"></div></div>';
    document.body.appendChild(o);
    const ok = o.querySelector('#pdok'), cb = o.querySelector('#pdc');
    const who = () => (o.querySelector('input[name=pdw]:checked') || {}).value;
    o.addEventListener('change', () => { ok.disabled = !(who() && cb.checked); });
    ok.onclick = () => {
      ok.disabled = true;
      fetch('/api/' + id + '/consent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ who: who() }) })
        .then(r => { if (!r.ok) throw 0; o.remove(); })
        .catch(() => { ok.disabled = false; o.querySelector('#pder').textContent = 'Не получилось сохранить, проверьте интернет и нажмите ещё раз.'; });
    };
  }).catch(() => {});
};
