document.documentElement.classList.add('js');
const observer = new IntersectionObserver(entries => { for(const entry of entries) if(entry.isIntersecting){entry.target.classList.add('is-visible');observer.unobserve(entry.target);} }, {threshold:.08});
document.querySelectorAll('.reveal').forEach(el => observer.observe(el));
const states = {
  listening:{hue:0,title:'A thought, caught.',copy:'Hold the button and speak. Let go when you’re done.'},
  working:{hue:57,title:'Your agent has it.',copy:'A quiet signal while the request moves forward.'},
  attention:{hue:190,title:'A little nudge.',copy:'Amber means there’s something to review on your phone or Mac.'},
  done:{hue:300,title:'All taken care of.',copy:'A brief green light, then back to your day.'}
};
const demo = document.querySelector('.device-demo');
const stateTitle = document.getElementById('state-title');
const stateCopy = document.getElementById('state-description');
function setState(name){
  if(!demo || !states[name]) return;
  const state=states[name];demo.style.setProperty('--hue',`${state.hue}deg`);
  stateTitle.textContent=state.title;stateCopy.textContent=state.copy;
  document.querySelectorAll('.state-button').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.state===name)));
}
let releaseTimer;
document.querySelectorAll('.state-button').forEach(button=>button.addEventListener('click',()=>{clearTimeout(releaseTimer);setState(button.dataset.state);}));
function hold(){clearTimeout(releaseTimer);demo.classList.add('is-held');setState('listening');}
function release(){if(!demo?.classList.contains('is-held'))return;demo.classList.remove('is-held');setState('working');releaseTimer=setTimeout(()=>setState('done'),1800);}
if(demo){demo.addEventListener('pointerdown',event=>{demo.setPointerCapture(event.pointerId);hold();});demo.addEventListener('pointerup',release);demo.addEventListener('pointercancel',release);demo.addEventListener('keydown',event=>{if((event.key===' '||event.key==='Enter')&&!event.repeat){event.preventDefault();hold();}});demo.addEventListener('keyup',event=>{if(event.key===' '||event.key==='Enter'){event.preventDefault();release();}});demo.addEventListener('blur',release);}
const roles={work:'“Summarize the customer call and draft my next steps.”',personal:'“Remind me to take the parcel when I leave tomorrow.”',ideas:'“Save this thought for the next time I work on the design.”'};
document.querySelectorAll('.role-button').forEach(button=>button.addEventListener('click',()=>{document.querySelectorAll('.role-button').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));document.getElementById('role-name').textContent=button.textContent;document.getElementById('role-example').textContent=roles[button.dataset.role];}));
