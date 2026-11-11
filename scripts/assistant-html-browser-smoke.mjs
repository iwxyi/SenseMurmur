const CLIENT_URL = process.env.PNEUMATA_CLIENT_URL || 'http://127.0.0.1:5173';
const CDP_URL = process.env.PNEUMATA_CDP_URL || 'http://127.0.0.1:9222';

async function cdpFetch(path, init) {
  const response = await fetch(`${CDP_URL}${path}`, init);
  if (!response.ok) throw new Error(`CDP ${path} failed: ${response.status} ${await response.text()}`);
  return response.json();
}

class CdpClient {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data.toString());
      const pending = this.pending.get(message.id);
      if (!pending) {
        this.events.push(message);
        return;
      }
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 15_000);
      this.pending.set(id, { resolve: (value) => { clearTimeout(timeout); resolve(value); }, reject });
    });
  }

  close() { this.ws.close(); }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function evaluate(cdp, expression, contextId) {
  const result = await cdp.send('Runtime.evaluate', { expression, contextId, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result?.value;
}

async function iframeTarget(parentId, previousId = '') {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const targets = await cdpFetch('/json/list');
    const match = targets.filter((target) => target.type === 'iframe' && target.parentId === parentId && target.id !== previousId).at(-1);
    if (match) return match;
    await wait(100);
  }
  throw new Error('Generated HTML iframe did not expose a browser debugging target');
}

const runtimeManifest = { schemaVersion: 1, presentation: 'fullscreen', executionMode: 'declarative' };
const brokenPage = '<!doctype html><html><head><title>broken</title></head><body><script>missingGameFunction()</script></body></html>';
const gamePage = `<!doctype html>
<html><head><title>六边形围堵猫咪</title><style>
body{margin:0;background:#f6f8f4;font-family:system-ui;color:#183128}main{max-width:560px;margin:auto;padding:16px}canvas{display:block;width:100%;max-width:520px;border-radius:12px;background:#fff;box-shadow:0 2px 12px #0002}p{font-weight:700}
</style></head><body><main><h1>围堵猫咪</h1><p id="status">点击六边形放置障碍：0</p><canvas id="board" width="520" height="360" aria-label="六边形棋盘"></canvas></main>
<script>
const canvas=document.querySelector('#board'); const ctx=canvas.getContext('2d'); const status=document.querySelector('#status'); let obstacles=0;
function hex(x,y,r,fill){ctx.beginPath();for(let i=0;i<6;i++){const a=Math.PI/3*i+Math.PI/6;const px=x+Math.cos(a)*r;const py=y+Math.sin(a)*r;i?ctx.lineTo(px,py):ctx.moveTo(px,py)}ctx.closePath();ctx.fillStyle=fill;ctx.fill();ctx.strokeStyle='#2f5d45';ctx.stroke();}
function draw(){ctx.clearRect(0,0,520,360);for(let row=0;row<5;row++)for(let col=0;col<7;col++)hex(58+col*66+(row%2)*33,48+row*58,30,'#d7eadb');hex(256,164,24,'#f5a623');}
canvas.addEventListener('click',(event)=>{obstacles++;status.textContent='点击六边形放置障碍：'+obstacles;draw();const rect=canvas.getBoundingClientRect();hex(event.clientX-rect.left,event.clientY-rect.top,18,'#48545b');}); draw();
</script></body></html>`;

async function installFrame(cdp, html) {
  const expression = `(async()=>{
    const { buildAssistantHtmlDocument }=await import('/src/features/assistantHtml/assistantHtmlDocument.ts');
    window.__assistantHtmlSmokeEvents=[];
    if(window.__assistantHtmlSmokeListener)window.removeEventListener('message',window.__assistantHtmlSmokeListener);
    window.__assistantHtmlSmokeListener=(event)=>window.__assistantHtmlSmokeEvents.push(event.data);
    window.addEventListener('message',window.__assistantHtmlSmokeListener);
    document.querySelector('#assistant-html-smoke')?.remove();
    const frame=document.createElement('iframe');
    frame.id='assistant-html-smoke';
    frame.setAttribute('sandbox','allow-scripts allow-forms');
    document.body.append(frame);
    frame.srcdoc=buildAssistantHtmlDocument({html:${JSON.stringify(html)},manifest:${JSON.stringify(runtimeManifest)},channelToken:'browser-smoke',artifactId:'browser-artifact',versionId:'browser-version',applicationOrigin:location.origin});
    await new Promise((resolve)=>frame.addEventListener('load',resolve,{once:true}));
    frame.contentWindow.postMessage({type:'host_ready',channelToken:'browser-smoke',artifactId:'browser-artifact',versionId:'browser-version'},'*');
    return true;
  })()`;
  await evaluate(cdp, expression);
  await wait(200);
}

async function main() {
  const page = await cdpFetch(`/json/new?${encodeURIComponent(CLIENT_URL)}`, { method: 'PUT' });
  const cdp = new CdpClient(page.webSocketDebuggerUrl);
  await cdp.open();
  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: CLIENT_URL });
    await wait(1_500);

    await installFrame(cdp, brokenPage);
    const parentFrame = await evaluate(cdp, `(()=>{const frame=document.querySelector('#assistant-html-smoke');return frame&&{html:frame.outerHTML,srcdocLength:frame.srcdoc.length,hasWindow:Boolean(frame.contentWindow),hasDocument:Boolean(frame.contentDocument),ready:frame.contentDocument?.readyState}})()`);
    if (!parentFrame) throw new Error('Generated iframe was removed from the parent document');
    const brokenTarget = await iframeTarget(page.id);
    const brokenCdp = new CdpClient(brokenTarget.webSocketDebuggerUrl);
    await brokenCdp.open();
    await brokenCdp.send('Runtime.enable');
    const diagnostic = await evaluate(cdp, 'window.__assistantHtmlSmokeEvents.find((event)=>event.type==="error")');
    if (!diagnostic || diagnostic.errorInfo?.kind !== 'runtime' || !String(diagnostic.error).includes('missingGameFunction')) {
      const events = await evaluate(cdp, 'window.__assistantHtmlSmokeEvents');
      const childHtml = await evaluate(brokenCdp, 'document.documentElement.outerHTML');
      throw new Error(`Runtime diagnostic was not returned: ${JSON.stringify({ diagnostic, events, parentFrame, childHtml })}`);
    }
    brokenCdp.close();

    await installFrame(cdp, gamePage);
    const gameTarget = await iframeTarget(page.id, brokenTarget.id);
    const gameCdp = new CdpClient(gameTarget.webSocketDebuggerUrl);
    await gameCdp.open();
    await gameCdp.send('Runtime.enable');
    const before = await evaluate(gameCdp, `({canvas:Boolean(document.querySelector('#board')),pixels:Array.from(document.querySelector('#board').getContext('2d').getImageData(256,164,1,1).data),status:document.querySelector('#status').textContent})`);
    await evaluate(gameCdp, `document.querySelector('#board').dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:110,clientY:110}))`);
    const after = await evaluate(gameCdp, `document.querySelector('#status').textContent`);
    const errors = await evaluate(cdp, 'window.__assistantHtmlSmokeEvents.filter((event)=>event.type==="error")');
    gameCdp.close();
    if (!before.canvas || before.pixels.every((pixel) => pixel === 0) || after !== '点击六边形放置障碍：1' || errors.length !== 0) {
      throw new Error(`Canvas game smoke failed: ${JSON.stringify({ before, after, errors })}`);
    }
    console.log(JSON.stringify({ diagnostic: diagnostic.errorInfo, canvasPixels: before.pixels, interaction: after, errors: errors.length }, null, 2));
  } finally {
    cdp.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
