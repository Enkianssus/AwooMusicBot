/**
 * OBS Mod UI host, served by the external read-only API under /overlay/.
 *
 * The fixed host page embeds the active Mod UI in a sandboxed iframe, polls
 * /api/v1/overlay for live switching and hands each mod its settings through
 * postMessage.  Mod HTML gets a small runtime that applies those settings as
 * CSS variables and data attributes.  The host never trusts mod content: the
 * iframe has no same-origin access and its CSP blocks plugins and <base>.
 *
 * No Electron import; the overlay registry and the hls.js file are injected.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';

export interface ObsOverlayAsset {
  filePath: string;
  contentType: string;
  revision: string;
  /** Entry HTML of the active Mod, relative to its root, e.g. dist/index.html. */
  entry?: string;
}

export interface ObsOverlayHostOptions {
  resolveActiveAsset: (relativePath: string) => Promise<ObsOverlayAsset | null>;
  /** Reads the browser build of hls.js; called once and memoized. */
  readVendorScript: () => Promise<Buffer>;
  /** Bundled hls.js version, used for the immutable versioned alias. */
  vendorVersion: string;
}

export interface ObsOverlayHost {
  serve(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string
  ): Promise<boolean>;
}

export const OBS_OVERLAY_VENDOR_PATH = '/overlay/vendor/hls.min.js';
const CONTENT_PREFIX = '/overlay/content/';
const RUNTIME_TAG = '<script src="/overlay/runtime.js" defer data-awoo-overlay-runtime></script>';

const OBS_OVERLAY_HOST_CSP =
  "default-src 'self'; frame-src 'self'; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'";

export const OBS_OVERLAY_CONTENT_CSP =
  "default-src 'self'; connect-src http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:* https://*.itunes.apple.com https://*.mzstatic.com; media-src blob: https://*.itunes.apple.com https://*.mzstatic.com; img-src http: https: data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'self' file: http://127.0.0.1:* http://localhost:*";

export const OBS_OVERLAY_HOST_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>嗷呜点歌机 Mod UI</title>
  <link rel="stylesheet" href="/overlay/host.css">
  <script src="/overlay/host.js" defer></script>
</head>
<body>
  <iframe id="awoo-overlay-frame" title="嗷呜点歌机 Mod UI" sandbox="allow-scripts"></iframe>
  <div id="awoo-overlay-status">正在载入 Mod UI…</div>
</body>
</html>`;

export const OBS_OVERLAY_HOST_CSS = `
html,body,#awoo-overlay-frame{width:100%;height:100%;margin:0;background:transparent}
body{overflow:hidden}
#awoo-overlay-frame{display:block;border:0;opacity:0;transition:opacity .16s ease}
#awoo-overlay-frame[data-ready="true"]{opacity:1}
#awoo-overlay-status{position:fixed;left:16px;top:16px;padding:8px 11px;border:1px solid rgba(120,190,255,.35);border-radius:10px;background:rgba(12,24,40,.72);color:#bfe3ff;font:12px/1.4 system-ui,sans-serif}
#awoo-overlay-frame[data-ready="true"]+#awoo-overlay-status{display:none}
`;

export const OBS_OVERLAY_HOST_JS = `
(function(){
  var frame=document.getElementById('awoo-overlay-frame');
  var status=document.getElementById('awoo-overlay-status');
  var revision='';
  var activeState=null;
  var deliveredSettings='';
  // OBS 地址上的查询参数（如 ?port=6000）转交给 Mod 页面；revision 只由宿主设置，用于切换后刷新。
  var forwardedQuery='';
  try{
    new URLSearchParams(window.location.search).forEach(function(value,key){
      if(key!=='revision')forwardedQuery+='&'+encodeURIComponent(key)+'='+encodeURIComponent(value);
    });
  }catch(_error){forwardedQuery='';}
  function contentUrl(active,next){
    // 直接打开入口文件，dist/index.html 这类嵌套入口的相对资源才能正确解析。
    var entry=typeof active.entry==='string'?active.entry:'';
    var path=entry?entry.split('/').map(encodeURIComponent).join('/'):'';
    return '/overlay/content/'+path+'?revision='+encodeURIComponent(next)+forwardedQuery;
  }
  function deliverSettings(force){
    if(!activeState||!frame.contentWindow)return;
    var message={
      type:'awoo-overlay-settings',
      overlayId:activeState.id||'builtin',
      definitions:Array.isArray(activeState.settings)?activeState.settings:[],
      values:activeState.values&&typeof activeState.values==='object'?activeState.values:{}
    };
    var key=revision+'|'+JSON.stringify(message.values);
    if(!force&&key===deliveredSettings)return;
    deliveredSettings=key;
    frame.contentWindow.postMessage(message,'*');
  }
  function refresh(){
    fetch('/api/v1/overlay',{cache:'no-store'}).then(function(response){
      if(!response.ok)throw new Error('HTTP '+response.status);
      return response.json();
    }).then(function(state){
      var active=state&&state.active?state.active:{};
      var next=[active.id||'builtin',active.version||'',active.installedAt||''].join('@');
      activeState=active;
      if(next!==revision){
        revision=next;
        deliveredSettings='';
        frame.dataset.ready='false';
        status.textContent='正在载入 '+(active.name||'Mod UI')+'…';
        frame.src=contentUrl(active,next);
        return;
      }
      // 参数没变时不重复发送；新页面载入和 awoo-overlay-ready 握手会补发，
      // 覆盖导航期间或后台节流时错过的消息。
      deliverSettings(false);
    }).catch(function(error){
      status.textContent='Mod UI 无法载入：'+error.message;
    });
  }
  frame.addEventListener('load',function(){
    frame.dataset.ready='true';
    deliverSettings(true);
  });
  window.addEventListener('message',function(event){
    if(event.source===frame.contentWindow&&event.data&&event.data.type==='awoo-overlay-ready'){
      deliverSettings(true);
    }
  });
  refresh();
  window.setInterval(refresh,500);
}());
`;

export const OBS_OVERLAY_RUNTIME_JS = `
(function(){
  'use strict';
  var current={overlayId:'',definitions:[],values:{}};
  var applied=[];
  var appliedPayload='';
  var subscribers=[];
  function attributeName(key){
    return 'data-awoo-setting-'+String(key||'').replace(/([a-z0-9])([A-Z])/g,'$1-$2').replace(/[^A-Za-z0-9_-]/g,'-').toLowerCase();
  }
  function cssValue(definition,value){
    if(typeof value==='boolean')return value?'1':'0';
    return String(value)+(definition.cssUnit||'');
  }
  function apply(payload){
    var serialized='';
    try{serialized=JSON.stringify(payload);}catch(_error){}
    // 相同参数的补发不重建样式，也不重复通知 Mod。
    if(serialized&&serialized===appliedPayload)return;
    appliedPayload=serialized;
    var root=document.documentElement;
    applied.forEach(function(definition){
      if(definition.cssVariable)root.style.removeProperty(definition.cssVariable);
      root.removeAttribute(attributeName(definition.key));
    });
    var definitions=Array.isArray(payload.definitions)?payload.definitions:[];
    var values=payload.values&&typeof payload.values==='object'?payload.values:{};
    definitions.forEach(function(definition){
      if(!definition||typeof definition.key!=='string')return;
      var value=Object.prototype.hasOwnProperty.call(values,definition.key)?values[definition.key]:definition.default;
      if(typeof definition.cssVariable==='string'&&/^--[a-z][a-z0-9-]*$/.test(definition.cssVariable)){
        root.style.setProperty(definition.cssVariable,cssValue(definition,value));
      }
      root.setAttribute(attributeName(definition.key),String(value));
    });
    applied=definitions;
    current={overlayId:String(payload.overlayId||''),definitions:definitions,values:Object.assign({},values)};
    var detail={overlayId:current.overlayId,definitions:current.definitions,values:Object.assign({},current.values)};
    window.dispatchEvent(new CustomEvent('awoo-overlay-settings',{detail:detail}));
    subscribers.slice().forEach(function(callback){try{callback(detail);}catch(_error){}});
  }
  window.AwooOverlay={
    getSettings:function(){return Object.assign({},current.values);},
    subscribe:function(callback){
      if(typeof callback!=='function')return function(){};
      subscribers.push(callback);
      if(current.overlayId)callback({overlayId:current.overlayId,definitions:current.definitions,values:Object.assign({},current.values)});
      return function(){subscribers=subscribers.filter(function(item){return item!==callback;});};
    }
  };
  window.addEventListener('message',function(event){
    if(event.source!==window.parent||!event.data||event.data.type!=='awoo-overlay-settings')return;
    apply(event.data);
  });
  window.parent.postMessage({type:'awoo-overlay-ready'},'*');
}());
`;

/**
 * Adds the settings runtime to a Mod UI document: after <head>, else after
 * <html>, else after the doctype, else at the start.  Nothing is ever placed
 * before the doctype, which would switch the page to quirks mode.
 */
export function injectObsOverlayRuntime(content: Buffer): Buffer {
  const html = content.toString('utf8');
  if (html.includes('data-awoo-overlay-runtime')) return content;
  // Search a copy with comments blanked so commented-out tags are skipped;
  // equal lengths keep the indexes valid for the original text.
  const masked = html.replace(/<!--[\s\S]*?-->/g, comment => ' '.repeat(comment.length));
  // \s also matches a leading byte order mark.
  const doctype = /^\s*<!doctype[^>]*>/i.exec(masked);
  const start = doctype ? doctype[0].length : 0;
  const bodyOffset = masked.slice(start).search(/<body[\s>]/i);
  const limit = bodyOffset === -1 ? masked.length : start + bodyOffset;
  const endOfTag = (pattern: RegExp): number => {
    pattern.lastIndex = start;
    const match = pattern.exec(masked);
    return match && match.index < limit ? match.index + match[0].length : -1;
  };
  const afterHead = endOfTag(/<head(?:\s[^>]*)?>/gi);
  const afterHtml = afterHead === -1 ? endOfTag(/<html(?:\s[^>]*)?>/gi) : -1;
  let injected: string;
  if (afterHead !== -1) {
    injected = `${html.slice(0, afterHead)}\n  ${RUNTIME_TAG}${html.slice(afterHead)}`;
  } else if (afterHtml !== -1) {
    injected = `${html.slice(0, afterHtml)}\n${RUNTIME_TAG}${html.slice(afterHtml)}`;
  } else if (doctype) {
    injected = `${html.slice(0, start)}\n${RUNTIME_TAG}${html.slice(start)}`;
  } else {
    const bom = html.charCodeAt(0) === 0xfeff ? 1 : 0;
    injected = `${html.slice(0, bom)}${RUNTIME_TAG}\n${html.slice(bom)}`;
  }
  return Buffer.from(injected, 'utf8');
}

function matchesEntityTag(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header.split(',').some(candidate => {
    const value = candidate.trim();
    return value === '*' || value === etag || value === `W/${etag}`;
  });
}

export function createObsOverlayHost({
  resolveActiveAsset,
  readVendorScript,
  vendorVersion
}: ObsOverlayHostOptions): ObsOverlayHost {
  // The versioned alias is immutable, so only a plain version string gets one.
  const versionedVendorPath = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(vendorVersion)
    ? `/overlay/vendor/hls-${vendorVersion}.min.js`
    : '';
  let vendorScript: Promise<{ body: Buffer; etag: string }> | null = null;

  function loadVendorScript(): Promise<{ body: Buffer; etag: string }> {
    if (!vendorScript) {
      const pending = readVendorScript().then(body => ({
        body,
        etag: `"hls-${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`
      }));
      vendorScript = pending;
      // A failed read is retried by the next request instead of being cached.
      pending.catch(() => {
        if (vendorScript === pending) vendorScript = null;
      });
    }
    return vendorScript;
  }

  async function serve(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string
  ): Promise<boolean> {
    try {
      if (pathname === '/overlay/' || pathname === '/overlay/index.html') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Security-Policy', OBS_OVERLAY_HOST_CSP);
        res.end(OBS_OVERLAY_HOST_HTML);
        return true;
      }
      if (pathname === '/overlay/host.css') {
        res.setHeader('Content-Type', 'text/css; charset=utf-8');
        res.end(OBS_OVERLAY_HOST_CSS);
        return true;
      }
      if (pathname === '/overlay/host.js') {
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        res.end(OBS_OVERLAY_HOST_JS);
        return true;
      }
      if (pathname === '/overlay/runtime.js') {
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        res.end(OBS_OVERLAY_RUNTIME_JS);
        return true;
      }
      if (
        pathname === OBS_OVERLAY_VENDOR_PATH
        || (versionedVendorPath && pathname === versionedVendorPath)
      ) {
        const { body, etag } = await loadVendorScript();
        // These override the server's default no-store: the plain path is
        // revalidated with the ETag, the versioned alias never changes.
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        res.setHeader('ETag', etag);
        res.setHeader(
          'Cache-Control',
          pathname === OBS_OVERLAY_VENDOR_PATH ? 'no-cache' : 'public, max-age=31536000, immutable'
        );
        if (matchesEntityTag(req.headers['if-none-match'], etag)) {
          res.writeHead(304);
          res.end();
          return true;
        }
        res.end(body);
        return true;
      }
      if (!pathname.startsWith(CONTENT_PREFIX)) return false;
      let relativePath: string | null;
      try {
        relativePath = decodeURIComponent(pathname.slice(CONTENT_PREFIX.length));
      } catch {
        relativePath = null;
      }
      const asset = relativePath === null ? null : await resolveActiveAsset(relativePath);
      if (!asset) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Mod UI asset not found');
        return true;
      }
      // The bare content root, used by older host pages, would serve a nested
      // entry such as dist/index.html with the wrong base for its assets.
      if (relativePath?.replace(/^\/+/, '') === '' && asset.entry) {
        const { search } = new URL(req.url || '/', 'http://127.0.0.1');
        const entryPath = asset.entry.split('/').map(encodeURIComponent).join('/');
        res.writeHead(302, { Location: `${CONTENT_PREFIX}${entryPath}${search}` });
        res.end();
        return true;
      }
      const rawContent = await fs.promises.readFile(asset.filePath);
      const content = asset.contentType.startsWith('text/html')
        ? injectObsOverlayRuntime(rawContent)
        : rawContent;
      res.setHeader('Content-Type', asset.contentType);
      res.setHeader('X-Awoo-Overlay-Revision', asset.revision);
      res.setHeader('Content-Security-Policy', OBS_OVERLAY_CONTENT_CSP);
      res.end(content);
    } catch (error: unknown) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      res.end(
        `OBS overlay unavailable: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return true;
  }

  return { serve };
}
