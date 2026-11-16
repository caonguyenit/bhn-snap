/* BHN_SNAP_ENGINE
 * BHN Snap — engine điều phối tải video / ảnh / âm thanh cho Phím tắt iOS.
 * (c) BHN Media — bhnmedia.vn
 *
 * Phím tắt "BHN Snap" chỉ là bộ máy chạy: mỗi bước nó gửi cho engine này
 * (input, cài đặt, trạng thái, phản hồi mạng gần nhất) và nhận lại 1 lệnh:
 *   fetch  -> gọi 1 request HTTP rồi đưa phản hồi lại cho engine
 *   menu   -> hiện danh sách cho người dùng chọn
 *   done   -> danh sách tệp cần tải & lưu
 *   error  -> báo lỗi
 * Muốn đổi / thêm API: chỉ sửa file này (mục CONFIG + PROVIDERS) rồi đẩy lên GitHub.
 * Phím tắt tự lấy bản mới ở lần chạy sau, không cần cài lại.
 */
var BHN_SNAP_ENGINE = (function () {
  'use strict';

  var ENGINE_VERSION = '2026.11.17-1';
  var MIN_SHORTCUT_VERSION = 1;

  var UA = {
    chrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
    app: 'BHNSnap/1.0 (+https://bhnmedia.vn)',
    ytvr: 'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip'
  };

  /* ========================= CẤU HÌNH (sửa ở đây) ========================= */
  var CONFIG = {
    // Danh sách cobalt API công khai, thử lần lượt. Có thể thêm {api, key}.
    // Instance của riêng bạn (nếu có) nhập trong cài đặt Phím tắt: cobalt_api / cobalt_key.
    cobalt: [
      // (16/11/2026: meowing.de, canine.tools, api.cobalt.tools, 3kh0 đã bắt buộc JWT/Turnstile -> bỏ)
      { api: 'https://cobaltapi.cjs.nz', key: '' }
    ],
    // true = mọi tệp đi qua tunnel của instance (ít tên miền -> ít hỏi quyền hơn)
    cobaltAlwaysProxy: true,
    tikwm: 'https://www.tikwm.com',
    fxtwitter: 'https://api.fxtwitter.com',
    vxtwitter: 'https://api.vxtwitter.com',
    // Thứ tự nhà cung cấp cho từng nền tảng (lỗi cái trước sẽ tự chuyển sang cái sau)
    routes: {
      tiktok: ['tikwm', 'cobalt', 'tiktokweb'],
      douyin: ['douyin'],
      twitter: ['fxtwitter', 'vxtwitter', 'cobalt'],
      instagram: ['igembed', 'cobalt', 'iggql'],
      facebook: ['fbweb', 'cobalt'],
      youtube: ['cobalt', 'ytinner'],
      threads: ['threads', 'og'],
      xiaohongshu: ['xhs'],
      reddit: ['cobalt', 'redditjson'],
      other: ['cobalt', 'og']
    },
    maxMenuItems: 30,
    // false = không dùng 'Khớp văn bản' của iOS, engine tự lọc trang bằng JavaScript
    useGrep: false
  };
  /* ======================================================================= */

  var PLATFORMS = [
    ['tiktok', /(^|\.)tiktok\.com$/],
    ['douyin', /(^|\.)(douyin\.com|iesdouyin\.com)$/],
    ['twitter', /(^|\.)(twitter\.com|x\.com|fxtwitter\.com|vxtwitter\.com|fixupx\.com|fixvx\.com)$/],
    ['instagram', /(^|\.)(instagram\.com|instagr\.am|ddinstagram\.com)$/],
    ['facebook', /(^|\.)(facebook\.com|fb\.watch|fb\.com)$/],
    ['youtube', /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/],
    ['threads', /(^|\.)(threads\.net|threads\.com)$/],
    ['xiaohongshu', /(^|\.)(xiaohongshu\.com|xhslink\.com)$/],
    ['reddit', /(^|\.)(reddit\.com|redd\.it)$/]
  ];

  var PLATFORM_NAMES = {
    tiktok: 'TikTok', douyin: 'Douyin', twitter: 'X/Twitter', instagram: 'Instagram',
    facebook: 'Facebook', youtube: 'YouTube', threads: 'Threads', xiaohongshu: 'Xiaohongshu',
    reddit: 'Reddit', other: 'trang web', direct: 'link trực tiếp'
  };

  /* ----------------------------- tiện ích ----------------------------- */
  function parseJSON(s) {
    if (s === null || s === undefined) return null;
    if (typeof s === 'object') return s;
    try { return JSON.parse(String(s)); } catch (e) {}
    if (/^\s*<\?xml[\s\S]*<plist/.test(String(s))) return parsePlistXML(String(s));
    return null;
  }
  function parsePlistXML(s) {
    try {
      if (typeof DOMParser === 'undefined') return null;
      var doc = new DOMParser().parseFromString(s, 'text/xml');
      var root = doc.getElementsByTagName('plist')[0];
      var conv = function (n) {
        switch (n.tagName) {
          case 'dict': var o = {}, c = n.children; for (var i = 0; i + 1 < c.length; i += 2) o[c[i].textContent] = conv(c[i + 1]); return o;
          case 'array': return [].map.call(n.children, conv);
          case 'integer': return parseInt(n.textContent, 10);
          case 'real': return parseFloat(n.textContent);
          case 'true': return true;
          case 'false': return false;
          default: return n.textContent;
        }
      };
      return root && root.firstElementChild ? conv(root.firstElementChild) : null;
    } catch (e) { return null; }
  }
  function snip(s) {
    s = String(s === undefined || s === null ? '' : s);
    return '[' + s.length + ' ký tự] ' + s.slice(0, 90).replace(/\s+/g, ' ');
  }
  function localGrep(s, g) {
    try { return (String(s).match(new RegExp(g, 'g')) || []).join('\n'); } catch (e) { return String(s); }
  }
  function b64e(s) { return btoa(unescape(encodeURIComponent(s))); }
  function trim(s) { return String(s === undefined || s === null ? '' : s).replace(/^\s+|\s+$/g, ''); }
  function hostOf(u) { var m = /^https?:\/\/([^\/?#:]+)/i.exec(u || ''); return m ? m[1].toLowerCase() : ''; }
  function originOf(u) { var h = hostOf(u); return h ? 'https://' + h + '/' : ''; }
  function qenc(s) { return encodeURIComponent(s); }
  function jsonUnescape(s) { try { return JSON.parse('"' + s + '"'); } catch (e) { return String(s).replace(/\\\//g, '/'); } }
  function htmlUnescape(s) {
    return String(s).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&#39;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x2F;/gi, '/');
  }
  function uniq(list, key) {
    var seen = {}, out = [];
    for (var i = 0; i < list.length; i++) {
      var k = key ? key(list[i]) : list[i];
      if (!k || seen[k]) continue;
      seen[k] = 1; out.push(list[i]);
    }
    return out;
  }
  function extOf(u, def) {
    var m = /\.([a-z0-9]{2,4})(?:$|[?#&])/i.exec(String(u || '').split('?')[0] + '?');
    var e = m ? m[1].toLowerCase() : '';
    if (e === 'jpeg') e = 'jpg';
    var ok = { mp4: 1, mov: 1, m4v: 1, webm: 1, jpg: 1, png: 1, webp: 1, gif: 1, heic: 1, mp3: 1, m4a: 1, aac: 1, wav: 1, ogg: 1, opus: 1 };
    if (ok[e]) return e;
    var fm = /[?&]format=([a-z0-9]+)/i.exec(u || '');
    if (fm && ok[fm[1].toLowerCase()]) return fm[1].toLowerCase();
    return def;
  }
  function kindOfExt(e) {
    if (/^(mp3|m4a|aac|wav|ogg|opus)$/.test(e)) return 'audio';
    if (/^(jpg|png|webp|gif|heic)$/.test(e)) return 'image';
    return 'video';
  }
  function file(url, kind, ext, extra) {
    var f = { url: url, kind: kind, ext: ext || (kind === 'audio' ? 'mp3' : kind === 'image' ? 'jpg' : 'mp4') };
    if (extra) { for (var k in extra) if (extra.hasOwnProperty(k)) f[k] = extra[k]; }
    return f;
  }
  function opt(label, files, def, again) {
    return { label: label, files: files || [], def: !!def, again: again || '' };
  }
  function icon(kind) { return kind === 'audio' ? '🎵' : kind === 'image' ? '🖼' : '🎬'; }
  function kindName(kind) { return kind === 'audio' ? 'Âm thanh' : kind === 'image' ? 'Ảnh' : 'Video'; }
  function randToken(n) {
    var c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_', s = '';
    for (var i = 0; i < n; i++) s += c.charAt(Math.floor(Math.random() * c.length));
    return s;
  }
  function isTrue(v, def) {
    if (v === undefined || v === null || v === '') return def;
    if (typeof v === 'string') return !/^(0|false|no|off|không|khong)$/i.test(trim(v));
    return !!v;
  }

  // Bộ lựa chọn chung cho bài có nhiều media
  function listOptions(files, extraAudio, defaultAll) {
    var opts = [];
    var vids = files.filter(function (f) { return f.kind === 'video'; });
    var imgs = files.filter(function (f) { return f.kind === 'image'; });
    if (files.length > 1) opts.push(opt('📦 Tải tất cả (' + files.length + ')', files, defaultAll !== false));
    if (vids.length > 1 && imgs.length > 0) opts.push(opt('🎬 Chỉ video (' + vids.length + ')', vids));
    if (imgs.length > 1 && vids.length > 0) opts.push(opt('🖼 Chỉ ảnh (' + imgs.length + ')', imgs));
    var counter = { video: 0, image: 0, audio: 0 };
    for (var i = 0; i < files.length && i < CONFIG.maxMenuItems; i++) {
      var f = files[i];
      counter[f.kind]++;
      opts.push(opt(icon(f.kind) + ' ' + kindName(f.kind) + ' ' + counter[f.kind], [f], files.length === 1));
    }
    if (extraAudio) opts.push(opt('🎵 Nhạc nền (' + (extraAudio.ext || 'mp3').toUpperCase() + ')', [extraAudio]));
    return opts;
  }

  /* ----------------------------- nhận diện link ----------------------------- */
  // Link bài đăng (không phải trang chủ / tài nguyên tĩnh)
  var POST_RE = /\/(video|videos|photo|reel|reels|p|tv|post|status|watch|shorts|live|share|story|stories|story\.php|permalink|item|comments|t|v|discovery|explore|note)\b|^https?:\/\/(vt\.|vm\.|v\.douyin|youtu\.be|fb\.watch|xhslink|redd\.it)/i;
  var ASSET_RE = /\.(js|mjs|css|woff2?|ttf|otf|eot|ico|svg|json|map|webmanifest|xml)(\?|#|$)|static|\/obj\/|fonts\.|gstatic|googleapis|googletagmanager|doubleclick|cloudflare|jsdelivr|unpkg|schema\.org|w3\.org/i;
  function isPostUrl(u) { return POST_RE.test(u); }
  // Tên miền chính của nền tảng (không phải máy chủ CDN/phụ như v16-webapp.tiktok.com)
  var MAIN_HOST_RE = /^((www|m|mobile|web|mbasic|vt|vm|v|old|new|music)\.)?[a-z0-9-]+\.[a-z]{2,}$/;
  // Link bài đăng có mã định danh rõ ràng -> ưu tiên cao nhất
  var ID_POST_RE = /\/@[^\/?#]+\/(video|photo)\/\d{6,}|\/(reel|reels|p|tv)\/[\w-]{5,}|\/status(es)?\/\d{6,}|youtube\.com\/(watch\?(.*&)?v=|shorts\/|live\/)[\w-]{11}|\/(videos|reel)\/\d{6,}|story_fbid=|\/share\/[rvp]\/|\/(explore|discovery\/item)\/[0-9a-f]{16,}|\/comments\/[a-z0-9]{4,}|\/post\/[\w-]{6,}|^https?:\/\/(vt\.tiktok|vm\.tiktok|v\.douyin|youtu\.be|fb\.watch|xhslink|redd\.it)/i;
  function urlScore(u) {
    var p = detect(u), asset = ASSET_RE.test(u);
    if (p !== 'other' && p !== 'direct' && MAIN_HOST_RE.test(hostOf(u)) && !asset) return ID_POST_RE.test(u) ? 4 : (isPostUrl(u) ? 3 : 2);
    return asset ? 0 : 1;
  }
  // Nội dung chia sẻ có thể là cả trang HTML (vd. chia sẻ từ trình duyệt trong Zalo) -> chọn link hợp lý nhất
  function extractUrl(text) {
    var t = String(text || '').replace(/\\u002[fF]/g, '/').replace(/\\\//g, '/');
    var all = t.match(/https?:\/\/[^\s<>"'`\\]+/gi) || [];
    if (!all.length) {
      var m2 = /(?:^|\s)((?:www\.|m\.|vt\.|vm\.|v\.)?[a-z0-9-]+\.(?:com|net|be|am|watch|it)\/[^\s<>"'`]+)/i.exec(t);
      return m2 ? 'https://' + m2[1].replace(/[),.;!?]+$/, '') : '';
    }
    for (var i = 0; i < all.length; i++) all[i] = htmlUnescape(all[i]).replace(/[),.;!?。，、]+$/, '');
    extractUrl.n = all.length;
    if (all.length === 1) return all[0];
    var best = null, cnt = {}, first = {};
    var norm = function (u) { return u.split(/[?#]/)[0].replace(/\/+$/, '').toLowerCase(); };
    for (i = 0; i < all.length; i++) { var k = norm(all[i]); cnt[k] = (cnt[k] || 0) + 1; if (!(k in first)) first[k] = i; }
    for (i = 0; i < all.length; i++) {
      var u = all[i], sc = urlScore(u), c = cnt[norm(u)];
      if (!best || sc > best.sc || (sc === best.sc && sc >= 3 && c > best.c)) best = { u: u, sc: sc, c: c };
    }
    return best.u;
  }
  function detect(u) {
    var h = hostOf(u);
    for (var i = 0; i < PLATFORMS.length; i++) if (PLATFORMS[i][1].test(h)) return PLATFORMS[i][0];
    if (/\.(mp4|mov|m4v|jpg|jpeg|png|webp|gif|mp3|m4a)(\?|$)/i.test(u)) return 'direct';
    return 'other';
  }

  /* ----------------------------- cobalt ----------------------------- */
  function cobaltList(cfg) {
    var list = [];
    var own = trim(cfg.cobalt_api);
    if (own) list.push({ api: own.replace(/\/+$/, ''), key: trim(cfg.cobalt_key) });
    for (var i = 0; i < CONFIG.cobalt.length; i++) list.push(CONFIG.cobalt[i]);
    return uniq(list, function (x) { return x.api; });
  }
  function cobaltParse(j, st) {
    if (!j || typeof j !== 'object') return { why: 'không phải JSON ' + snip(st._resp) };
    var title = st.title || '';
    if (j.status === 'tunnel' || j.status === 'redirect') {
      var e = extOf(j.filename || j.url, st.mode === 'audio' ? 'mp3' : 'mp4');
      var k = kindOfExt(e);
      var f = file(j.url, k, e);
      if (st.mode === 'audio' || k !== 'video') return { res: { title: title, opts: [opt(icon(k) + ' ' + kindName(k) + ' (' + e.toUpperCase() + ')', [f], true)] } };
      return { res: { title: title, opts: [
        opt('🎬 Video (' + (st.quality || '1080') + 'p, ' + e.toUpperCase() + ')', [f], true),
        opt('🎵 Chỉ âm thanh (MP3)', [], false, 'audio')
      ] } };
    }
    if (j.status === 'picker' && j.picker && j.picker.length) {
      var files = [];
      for (var i = 0; i < j.picker.length; i++) {
        var p = j.picker[i];
        if (!p || !p.url) continue;
        var kind = p.type === 'photo' ? 'image' : 'video';
        files.push(file(p.url, kind, extOf(p.url, kind === 'image' ? 'jpg' : 'mp4')));
      }
      var au = j.audio ? file(j.audio, 'audio', extOf(j.audioFilename || j.audio, 'mp3')) : null;
      if (st.mode === 'audio' && au) return { res: { title: title, opts: [opt('🎵 Nhạc nền', [au], true)] } };
      if (!files.length) return { why: 'picker rỗng' };
      return { res: { title: title, opts: listOptions(files, au) } };
    }
    if (j.status === 'local-processing') return { why: 'instance đòi xử lý cục bộ' };
    if (j.status === 'error') return { why: (j.error && j.error.code) || 'error' };
    return { why: 'trạng thái lạ: ' + j.status };
  }

  /* ----------------------------- Instagram helpers ----------------------------- */
  function igShortcode(u) {
    if (/instagram\.com\/share\//i.test(u || '') && !/canonical|og:url/.test(u || '')) return '';
    var m = /instagram\.com\/(?:[^\/?#]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,})/i.exec(u || '');
    return m ? m[1] : '';
  }
  function igFromShortcodeMedia(sm) {
    if (!sm) return [];
    var out = [];
    var side = sm.edge_sidecar_to_children && sm.edge_sidecar_to_children.edges;
    if (side && side.length) {
      for (var i = 0; i < side.length; i++) {
        var n = side[i].node || {};
        if (n.is_video && n.video_url) out.push(file(n.video_url, 'video', 'mp4'));
        else if (n.display_url) out.push(file(n.display_url, 'image', 'jpg'));
      }
      return out;
    }
    if (sm.video_url) return [file(sm.video_url, 'video', 'mp4')];
    if (sm.display_url) return [file(sm.display_url, 'image', 'jpg')];
    return out;
  }
  function igFromNewItem(d) {
    var out = [];
    function best(vs) { return vs.reduce(function (a, b) { return (a.width * a.height < b.width * b.height) ? b : a; }); }
    var list = d.carousel_media && d.carousel_media.length ? d.carousel_media : [d];
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (e.video_versions && e.video_versions.length) out.push(file(best(e.video_versions).url, 'video', 'mp4'));
      else if (e.image_versions2 && e.image_versions2.candidates && e.image_versions2.candidates.length) out.push(file(e.image_versions2.candidates[0].url, 'image', 'jpg'));
    }
    return out;
  }
  function igObjectFromEntries(name, data) {
    var re = new RegExp('\\["' + name + '",.*?,(\\{.*?\\}),\\d+\\]');
    var m = re.exec(data || '');
    if (!m) return null;
    return parseJSON(m[1]);
  }
  function igNumberFromQuery(name, data) {
    var m = new RegExp(name + '=(\\d+)').exec(data || '');
    return m && +m[1] ? +m[1] : 0;
  }
  var IG_EMBED_HEADERS = {
    'User-Agent': UA.chrome,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-GB,en;q=0.9',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Upgrade-Insecure-Requests': '1'
  };

  function ytId(u) {
    var m = /(?:v=|youtu\.be\/|\/shorts\/|\/live\/|\/embed\/|\/v\/)([A-Za-z0-9_-]{11})/.exec(u || '');
    return m ? m[1] : '';
  }

  /* =============================== PROVIDERS ===============================
   * Mỗi provider nhận (st, resp, cfg). st.step = 0 khi bắt đầu.
   * Trả về {req:{url,method,headers,body,grep}} | {res:{title,opts}} | {fail:'lý do'}
   * ======================================================================= */
  var P = {};

  P.tikwm = function (st, resp) {
    if (st.step === 0) {
      st.step = 1;
      return { req: { url: CONFIG.tikwm + '/api/?url=' + qenc(st.src) + '&hd=1', headers: { 'User-Agent': UA.chrome, 'Accept': 'application/json' } } };
    }
    var j = parseJSON(resp);
    if (!j) return { fail: 'phản hồi không phải JSON ' + snip(resp) };
    if (j.code !== 0 || !j.data) return { fail: j.msg || ('code ' + j.code) };
    var d = j.data;
    st.id = d.id || st.id;
    var title = d.title || '';
    var abs = function (u) { if (!u) return ''; return /^https?:\/\//i.test(u) ? u : CONFIG.tikwm + (u.charAt(0) === '/' ? '' : '/') + u; };
    var music = abs(d.music || (d.music_info && d.music_info.play));
    var mfile = music ? file(music, 'audio', extOf(music, 'mp3')) : null;
    if (d.images && d.images.length) {
      var imgs = d.images.map(function (u) { return file(abs(u), 'image', extOf(u, 'jpg')); });
      if (st.mode === 'audio' && mfile) return { res: { title: title, opts: [opt('🎵 Nhạc nền (MP3)', [mfile], true)] } };
      return { res: { title: title, opts: listOptions(imgs, mfile) } };
    }
    // play / hdplay = bản KHÔNG logo, KHÔNG đoạn credit cuối (wmplay mới có)
    var hd = abs(d.hdplay), sd = abs(d.play);
    if (st.mode === 'audio' && mfile) return { res: { title: title, opts: [opt('🎵 Âm thanh (MP3)', [mfile], true)] } };
    var opts = [];
    if (hd) opts.push(opt('🎬 Video HD – không logo', [file(hd, 'video', 'mp4')], true));
    if (sd && sd !== hd) opts.push(opt('🎬 Video thường – không logo', [file(sd, 'video', 'mp4')], !hd));
    if (mfile) opts.push(opt('🎵 Chỉ âm thanh (MP3)', [mfile]));
    if ((hd || sd) && mfile) opts.push(opt('🎬+🎵 Video HD + MP3', [file(hd || sd, 'video', 'mp4'), mfile]));
    if (!hd && !sd) return { fail: 'không có link video' };
    return { res: { title: title, opts: opts } };
  };

  P.cobalt = function (st, resp, cfg) {
    var list = cobaltList(cfg);
    if (st.step === 0) { st.d.k = 0; }
    else {
      st._resp = resp;
      var r = cobaltParse(parseJSON(resp), st);
      delete st._resp;
      if (r.res) return r;
      st.errs.push('cobalt[' + hostOf(list[st.d.k] && list[st.d.k].api) + ']: ' + r.why);
      st.d.k++;
    }
    if (st.d.k >= list.length) return { fail: 'đã thử hết ' + list.length + ' instance' };
    var inst = list[st.d.k];
    st.step++;
    var q = String(cfg.quality || '1080').replace(/p$/i, '');
    st.quality = q;
    var body = {
      url: st.src,
      videoQuality: q,
      audioFormat: 'mp3',
      downloadMode: st.mode === 'audio' ? 'audio' : 'auto',
      filenameStyle: 'basic',
      alwaysProxy: !!CONFIG.cobaltAlwaysProxy
    };
    var h = { 'User-Agent': UA.app, 'Accept': 'application/json', 'Content-Type': 'application/json' };
    if (inst.key) h['Authorization'] = (/^(Api-Key|Bearer) /.test(inst.key) ? inst.key : 'Api-Key ' + inst.key);
    return { req: { url: inst.api.replace(/\/+$/, '') + '/', method: 'POST', headers: h, body: JSON.stringify(body) } };
  };

  P.tiktokweb = function (st, resp) {
    if (st.step === 0) {
      st.step = 1;
      return { req: { url: st.src, headers: { 'User-Agent': UA.chrome, 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
        grep: '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">.*?</script>' } };
    }
    var m = /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application\/json">([\s\S]*?)<\/script>/.exec(resp || '');
    var data = m && parseJSON(m[1]);
    var det = data && data.__DEFAULT_SCOPE__ && data.__DEFAULT_SCOPE__['webapp.video-detail'];
    var it = det && det.itemInfo && det.itemInfo.itemStruct;
    if (!it) return { fail: (det && det.statusMsg) || ('không đọc được dữ liệu trang ' + snip(resp)) };
    st.id = it.id || st.id;
    var ref = { ref: 'https://www.tiktok.com/', ua: UA.chrome };
    var music = it.music && it.music.playUrl ? file(it.music.playUrl, 'audio', 'mp3', ref) : null;
    var imgs = it.imagePost && it.imagePost.images;
    if (imgs && imgs.length) {
      var files = [];
      for (var i = 0; i < imgs.length; i++) {
        var ul = (imgs[i].imageURL && imgs[i].imageURL.urlList) || [];
        var pick = ul.filter(function (x) { return /\.jpe?g\?/.test(x); })[0] || ul[0];
        if (pick) files.push(file(pick, 'image', 'jpg', ref));
      }
      return { res: { title: it.desc || '', opts: listOptions(files, music) } };
    }
    var play = it.video && it.video.playAddr;
    if (!play) return { fail: 'không có playAddr' };
    if (st.mode === 'audio' && music) return { res: { title: it.desc || '', opts: [opt('🎵 Âm thanh', [music], true)] } };
    var o = [opt('🎬 Video – không logo', [file(play, 'video', 'mp4', ref)], true)];
    if (music) o.push(opt('🎵 Chỉ âm thanh', [music]));
    return { res: { title: it.desc || '', opts: o } };
  };

  P.douyin = function (st, resp) {
    if (st.step === 0) {
      st.step = 1;
      var u = st.src, m = /douyin\.com\/(?:video|note)\/(\d+)/.exec(u) || /modal_id=(\d+)/.exec(u);
      if (m) u = 'https://www.iesdouyin.com/share/video/' + m[1] + '/';
      return { req: { url: u, headers: { 'User-Agent': UA.iphone, 'Referer': 'https://www.douyin.com/', 'Accept': 'text/html' },
        grep: '_ROUTER_DATA\\s*=\\s*\\{.*\\}' } };
    }
    var s = resp || '';
    var a = s.indexOf('{'), b = s.lastIndexOf('}');
    var data = a >= 0 && b > a ? parseJSON(s.slice(a, b + 1)) : null;
    var item = null;
    if (data && data.loaderData) {
      for (var k in data.loaderData) {
        var v = data.loaderData[k];
        if (v && v.videoInfoRes && v.videoInfoRes.item_list && v.videoInfoRes.item_list.length) { item = v.videoInfoRes.item_list[0]; break; }
      }
    }
    if (!item) return { fail: 'không đọc được dữ liệu Douyin' };
    st.id = item.aweme_id || st.id;
    var ex = { ua: UA.iphone, ref: 'https://www.douyin.com/' };
    var mu = item.music && item.music.play_url && item.music.play_url.url_list && item.music.play_url.url_list[0];
    var music = mu ? file(mu, 'audio', 'mp3', ex) : null;
    if (item.images && item.images.length) {
      var imgs = [];
      for (var i = 0; i < item.images.length; i++) {
        var ul = item.images[i].url_list || [];
        var pick = ul.filter(function (x) { return /\.jpe?g/.test(x); })[0] || ul[0];
        if (pick) imgs.push(file(pick, 'image', extOf(pick, 'jpg'), ex));
      }
      return { res: { title: item.desc || '', opts: listOptions(imgs, music) } };
    }
    var pa = item.video && item.video.play_addr && item.video.play_addr.url_list && item.video.play_addr.url_list[0];
    if (!pa) return { fail: 'không có play_addr' };
    pa = pa.replace('/playwm/', '/play/').replace('ratio=720p', 'ratio=1080p');
    if (st.mode === 'audio' && music) return { res: { title: item.desc || '', opts: [opt('🎵 Âm thanh', [music], true)] } };
    var o = [opt('🎬 Video – không logo', [file(pa, 'video', 'mp4', ex)], true)];
    if (music) o.push(opt('🎵 Chỉ âm thanh', [music]));
    return { res: { title: item.desc || '', opts: o } };
  };

  function twitterId(u) { var m = /\/status(?:es)?\/(\d+)/.exec(u || ''); return m ? m[1] : ''; }
  function twimgOrig(u) {
    var m = /^https?:\/\/pbs\.twimg\.com\/media\/([^.?\/]+)(?:\.([a-z]+))?/i.exec(u || '');
    if (!m) return u;
    var f = /[?&]format=([a-z]+)/i.exec(u);
    return 'https://pbs.twimg.com/media/' + m[1] + '?format=' + (m[2] || (f && f[1]) || 'jpg') + '&name=orig';
  }

  P.fxtwitter = function (st, resp) {
    var id = twitterId(st.src);
    if (!id) return { fail: 'không thấy ID tweet' };
    st.id = id;
    if (st.step === 0) {
      st.step = 1;
      return { req: { url: CONFIG.fxtwitter + '/2/status/' + id, headers: { 'User-Agent': UA.app, 'Accept': 'application/json' } } };
    }
    var j = parseJSON(resp);
    if (!j) return { fail: 'phản hồi không phải JSON ' + snip(resp) };
    var s = j.status || j.tweet;
    if (!s) return { fail: j.message || ('code ' + j.code) };
    var media = s.media || (s.quote && s.quote.media) || {};
    var all = media.all && media.all.length ? media.all : [].concat(media.photos || [], media.videos || []);
    var files = [];
    for (var i = 0; i < all.length; i++) {
      var m = all[i];
      if (m.type === 'photo') files.push(file(twimgOrig(m.url), 'image', extOf(m.url, 'jpg')));
      else if (m.type === 'video' || m.type === 'gif') {
        var url = m.url, best = -1;
        var fm = m.formats || m.variants || [];
        for (var x = 0; x < fm.length; x++) {
          var v = fm[x];
          var isMp4 = /mp4/i.test(v.container || v.content_type || v.url || '');
          if (isMp4 && (v.bitrate || 0) > best && v.url) { best = v.bitrate || 0; url = v.url; }
        }
        if (url) files.push(file(url, 'video', 'mp4'));
      }
    }
    if (!files.length) return { fail: 'tweet không có ảnh/video' };
    return { res: { title: s.text || '', opts: listOptions(files) } };
  };

  P.vxtwitter = function (st, resp) {
    var id = twitterId(st.src);
    if (!id) return { fail: 'không thấy ID tweet' };
    if (st.step === 0) {
      st.step = 1;
      return { req: { url: CONFIG.vxtwitter + '/Twitter/status/' + id, headers: { 'User-Agent': UA.app, 'Accept': 'application/json' } } };
    }
    var j = parseJSON(resp);
    if (!j) return { fail: 'phản hồi không phải JSON' };
    var files = [];
    var me = j.media_extended || [];
    for (var i = 0; i < me.length; i++) {
      if (me[i].type === 'image') files.push(file(twimgOrig(me[i].url), 'image', extOf(me[i].url, 'jpg')));
      else if (me[i].url) files.push(file(me[i].url, 'video', 'mp4'));
    }
    if (!files.length && j.mediaURLs) {
      for (var k = 0; k < j.mediaURLs.length; k++) { var e = extOf(j.mediaURLs[k], 'mp4'); files.push(file(j.mediaURLs[k], kindOfExt(e), e)); }
    }
    if (!files.length) return { fail: 'tweet không có ảnh/video' };
    return { res: { title: j.text || '', opts: listOptions(files) } };
  };

  P.fbweb = function (st, resp) {
    if (st.step === 0) {
      st.step = 1;
      var u = st.src.replace(/^https?:\/\/(m|mbasic|web|touch)\.facebook\.com/i, 'https://www.facebook.com');
      return { req: { url: u, headers: {
        'User-Agent': UA.chrome,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Dest': 'document'
      }, grep: '"(?:browser_native_hd_url|browser_native_sd_url|playable_url_quality_hd|playable_url)":"[^"]+"' } };
    }
    var hd = '', sd = '';
    var re = /"(browser_native_hd_url|browser_native_sd_url|playable_url_quality_hd|playable_url)":"([^"]+)"/g, m;
    while ((m = re.exec(resp || ''))) {
      var u = jsonUnescape(m[2]);
      if (!/^https?:/.test(u)) continue;
      if (!hd && (m[1] === 'browser_native_hd_url' || m[1] === 'playable_url_quality_hd')) hd = u;
      if (!sd && (m[1] === 'browser_native_sd_url' || m[1] === 'playable_url')) sd = u;
      if (hd && sd) break;
    }
    if (!hd && !sd) return { fail: 'không thấy video (bài riêng tư / cần đăng nhập?)' };
    var o = [];
    if (hd) o.push(opt('🎬 Video HD', [file(hd, 'video', 'mp4')], true));
    if (sd) o.push(opt('🎬 Video SD', [file(sd, 'video', 'mp4')], !hd));
    return { res: { title: '', opts: o } };
  };

  P.igembed = function (st, resp) {
    if (st.step === 0) {
      st.d.sc = igShortcode(st.src);
      if (!st.d.sc) {
        st.step = 1;
        return { req: { url: st.src, headers: IG_EMBED_HEADERS, grep: '<link rel="canonical" href="[^"]+"|<meta property="og:url" content="[^"]+"' } };
      }
      st.step = 1; resp = null;
    }
    if (st.step === 1) {
      if (!st.d.sc) {
        st.d.sc = igShortcode(htmlUnescape(resp || ''));
        if (!st.d.sc) return { fail: 'không lấy được mã bài viết' };
      }
      st.id = st.d.sc;
      st.step = 2;
      return { req: { url: 'https://www.instagram.com/p/' + st.d.sc + '/embed/captioned/', headers: IG_EMBED_HEADERS } };
    }
    var html = resp || '', files = [];
    try {
      var m = /"init",\[\],\[(.*?)\]\],/.exec(html);
      if (m) {
        var o = parseJSON(m[1]);
        var ctx = o && o.contextJSON ? parseJSON(o.contextJSON) : null;
        var g = ctx && ctx.gql_data;
        files = igFromShortcodeMedia(g && (g.shortcode_media || g.xdt_shortcode_media));
      }
    } catch (e) { files = []; }
    if (!files.length) {
      var vm = /"video_url":"([^"]+)"/.exec(html) || /\\"video_url\\":\\"(.+?)\\"/.exec(html);
      if (vm) files.push(file(jsonUnescape(vm[1].replace(/\\\\\//g, '/').replace(/\\\//g, '/')), 'video', 'mp4'));
    }
    if (!files.length) {
      var im = /class="EmbeddedMediaImage"[^>]*src="([^"]+)"/.exec(html) || /<img[^>]+class="EmbeddedMediaImage"[^>]*>/.exec(html);
      if (im && im[1]) files.push(file(htmlUnescape(im[1]), 'image', 'jpg'));
    }
    if (!files.length) return { fail: 'embed không có media (bài riêng tư / giới hạn tuổi?)' };
    return { res: { title: '', opts: listOptions(files) } };
  };

  P.iggql = function (st, resp) {
    if (st.step === 0) {
      st.d.sc = st.d.sc || igShortcode(st.src);
      if (!st.d.sc) return { fail: 'không có mã bài viết' };
      st.step = 1;
      return { req: { url: 'https://www.instagram.com/p/' + st.d.sc + '/', headers: IG_EMBED_HEADERS,
        grep: '\\["(?:SiteData|PolarisSiteData|DGWWebConfig|InstagramWebPushInfo|LSD|InstagramSecurityConfig|WebBloksVersioningID)",.*?,\\{.*?\\},\\d+\\]|(?:__comet_req|jazoest)=\\d+' } };
    }
    if (st.step === 1) {
      var html = resp || '';
      var site = igObjectFromEntries('SiteData', html) || {};
      var pol = igObjectFromEntries('PolarisSiteData', html) || {};
      var web = igObjectFromEntries('DGWWebConfig', html) || {};
      var push = igObjectFromEntries('InstagramWebPushInfo', html) || {};
      var lsdO = igObjectFromEntries('LSD', html) || {};
      var sec = igObjectFromEntries('InstagramSecurityConfig', html) || {};
      var lsd = lsdO.token || randToken(11);
      var csrf = sec.csrf_token || '';
      var cookie = [csrf && 'csrftoken=' + csrf, pol.device_id && 'ig_did=' + pol.device_id, 'wd=1280x720', 'dpr=2',
        pol.machine_id && 'mid=' + pol.machine_id, 'ig_nrcb=1'].filter(function (x) { return x; }).join('; ');
      var body = {
        __d: 'www', __a: '1', __s: '::' + Math.random().toString(36).substring(2).replace(/\d/g, '').slice(0, 6),
        __hs: site.haste_session || '20126.HYP:instagram_web_pkg.2.1...0', __req: 'b', __ccg: 'EXCELLENT',
        __rev: push.rollout_hash || '1019933358', __hsi: site.hsi || '7436540909012459023',
        __dyn: randToken(206), __csr: randToken(206), __user: '0',
        __comet_req: igNumberFromQuery('__comet_req', html) || '7', av: '0', dpr: '2', lsd: lsd,
        jazoest: igNumberFromQuery('jazoest', html) || Math.floor(Math.random() * 10000),
        __spin_r: site.__spin_r || '1019933358', __spin_b: site.__spin_b || 'trunk',
        __spin_t: site.__spin_t || Math.floor(Date.now() / 1000),
        fb_api_caller_class: 'RelayModern', fb_api_req_friendly_name: 'PolarisPostActionLoadPostQueryQuery',
        variables: JSON.stringify({ shortcode: st.d.sc, fetch_tagged_user_count: null, hoisted_comment_id: null, hoisted_reply_id: null }),
        server_timestamps: 'true', doc_id: '8845758582119845'
      };
      var form = [];
      for (var k in body) if (body.hasOwnProperty(k)) form.push(qenc(k) + '=' + qenc(body[k]));
      st.step = 2;
      return { req: { url: 'https://www.instagram.com/graphql/query', method: 'POST', body: form.join('&'), headers: {
        'User-Agent': UA.chrome,
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-FB-LSD': lsd,
        'X-CSRFToken': csrf || 'missing',
        'X-IG-App-ID': web.appId || '936619743392459',
        'X-ASBD-ID': '129477',
        'X-FB-Friendly-Name': 'PolarisPostActionLoadPostQueryQuery',
        'Cookie': cookie
      } } };
    }
    var j = parseJSON(resp);
    var d = j && j.data;
    var sm = d && (d.xdt_shortcode_media || d.shortcode_media);
    var files = igFromShortcodeMedia(sm);
    if (!files.length && j && j.items && j.items[0]) files = igFromNewItem(j.items[0]);
    if (!files.length) return { fail: 'graphql không trả media' };
    st.id = st.d.sc;
    return { res: { title: '', opts: listOptions(files) } };
  };

  P.ytinner = function (st, resp) {
    var id = ytId(st.src);
    if (!id) return { fail: 'không thấy ID video' };
    st.id = id;
    if (st.step === 0) {
      st.step = 1;
      var body = {
        context: { client: { clientName: 'ANDROID_VR', clientVersion: '1.65.10', deviceMake: 'Oculus', deviceModel: 'Quest 3',
          androidSdkVersion: 32, userAgent: UA.ytvr, osName: 'Android', osVersion: '12L', hl: 'en', timeZone: 'UTC', utcOffsetMinutes: 0 } },
        videoId: id, contentCheckOk: true, racyCheckOk: true,
        playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' } }
      };
      return { req: { url: 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false', method: 'POST', body: JSON.stringify(body), headers: {
        'User-Agent': UA.ytvr, 'Content-Type': 'application/json', 'X-YouTube-Client-Name': '28',
        'X-YouTube-Client-Version': '1.65.10', 'Origin': 'https://www.youtube.com' } } };
    }
    var j = parseJSON(resp);
    if (!j) return { fail: 'phản hồi không phải JSON' };
    var ps = j.playabilityStatus || {};
    if (ps.status !== 'OK') return { fail: ps.reason || ps.status || 'không phát được' };
    var sd = j.streamingData || {};
    var prog = (sd.formats || []).filter(function (f) { return f.url && /video\/mp4/.test(f.mimeType || ''); });
    prog.sort(function (a, b) { return (b.height || 0) - (a.height || 0); });
    var aud = (sd.adaptiveFormats || []).filter(function (f) { return f.url && /^audio\/mp4/.test(f.mimeType || ''); });
    aud.sort(function (a, b) { return (b.bitrate || 0) - (a.bitrate || 0); });
    var ex = { ua: UA.ytvr };
    var title = (j.videoDetails && j.videoDetails.title) || '';
    var afile = aud[0] ? file(aud[0].url, 'audio', 'm4a', ex) : null;
    if (st.mode === 'audio' && afile) return { res: { title: title, opts: [opt('🎵 Âm thanh (M4A)', [afile], true)] } };
    var o = [];
    if (prog[0]) o.push(opt('🎬 Video ' + (prog[0].qualityLabel || '') + ' (bản dự phòng, có tiếng)', [file(prog[0].url, 'video', 'mp4', ex)], true));
    if (afile) o.push(opt('🎵 Chỉ âm thanh (M4A)', [afile], !prog[0]));
    if (!o.length) return { fail: 'không có định dạng tải trực tiếp' };
    return { res: { title: title, opts: o } };
  };

  P.threads = function (st, resp) {
    if (st.step === 0) {
      st.step = 1;
      return { req: { url: st.src.replace('threads.com', 'threads.net'), headers: { 'User-Agent': UA.chrome, 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9', 'Sec-Fetch-Mode': 'navigate' },
        grep: '"video_versions":\\[\\{[^\\]]*?"url":"[^"]+"|"image_versions2":\\{"candidates":\\[\\{[^\\]]*?"url":"[^"]+"' } };
    }
    var lines = String(resp || '').split('\n'), vids = [], imgs = [];
    for (var i = 0; i < lines.length; i++) {
      var m = /"url":"([^"]+)"$/.exec(lines[i]);
      if (!m) continue;
      var u = jsonUnescape(m[1]);
      if (/^"video_versions"/.test(lines[i])) vids.push(file(u, 'video', 'mp4'));
      else imgs.push(file(u, 'image', extOf(u, 'jpg')));
    }
    vids = uniq(vids, function (f) { return f.url.split('?')[0]; });
    imgs = uniq(imgs, function (f) { return f.url.split('?')[0]; });
    var files = vids.length ? vids.concat(imgs.slice(vids.length)) : imgs;
    if (!files.length) return { fail: 'không thấy media' };
    return { res: { title: '', opts: listOptions(files) } };
  };

  P.xhs = function (st, resp) {
    if (st.step === 0) {
      st.step = 1;
      return { req: { url: st.src, headers: { 'User-Agent': UA.chrome, 'Accept': 'text/html', 'Referer': 'https://www.xiaohongshu.com/' },
        grep: '__INITIAL_STATE__\\s*=\\s*\\{.*\\}' } };
    }
    var s = String(resp || '');
    var a = s.indexOf('{'), b = s.lastIndexOf('}');
    var data = a >= 0 && b > a ? parseJSON(s.slice(a, b + 1).replace(/:undefined/g, ':null')) : null;
    var map = data && data.note && data.note.noteDetailMap, note = null;
    if (map) for (var k in map) { if (map[k] && map[k].note) { note = map[k].note; break; } }
    if (!note) return { fail: 'không đọc được ghi chú (cần đăng nhập?)' };
    st.id = note.noteId || st.id;
    var ex = { ref: 'https://www.xiaohongshu.com/', ua: UA.chrome };
    var files = [];
    var stream = note.video && note.video.media && note.video.media.stream;
    var v = stream && ((stream.h264 && stream.h264[0]) || (stream.h265 && stream.h265[0]));
    if (v && (v.masterUrl || (v.backupUrls && v.backupUrls[0]))) files.push(file(v.masterUrl || v.backupUrls[0], 'video', 'mp4', ex));
    else if (note.imageList) {
      for (var i = 0; i < note.imageList.length; i++) {
        var im = note.imageList[i];
        var u = im.urlDefault || im.url || (im.infoList && im.infoList[im.infoList.length - 1] && im.infoList[im.infoList.length - 1].url);
        if (u) files.push(file(u, 'image', extOf(u, 'jpg'), ex));
      }
    }
    if (!files.length) return { fail: 'ghi chú không có media' };
    return { res: { title: note.title || note.desc || '', opts: listOptions(files) } };
  };

  P.redditjson = function (st, resp) {
    if (st.step === 0) {
      if (!/\/comments\//.test(st.src)) return { fail: 'chỉ hỗ trợ link /comments/' };
      st.step = 1;
      return { req: { url: st.src.split('?')[0].replace(/\/$/, '') + '.json?raw_json=1', headers: { 'User-Agent': UA.app, 'Accept': 'application/json' } } };
    }
    var j = parseJSON(resp);
    var p = j && j[0] && j[0].data && j[0].data.children && j[0].data.children[0] && j[0].data.children[0].data;
    if (!p) return { fail: 'không đọc được bài' };
    st.id = p.id || st.id;
    var files = [];
    if (p.is_gallery && p.media_metadata) {
      var order = (p.gallery_data && p.gallery_data.items) || [];
      for (var i = 0; i < order.length; i++) {
        var mm = p.media_metadata[order[i].media_id];
        if (mm && mm.s && (mm.s.u || mm.s.gif)) files.push(file(mm.s.u || mm.s.gif, 'image', extOf(mm.s.u || mm.s.gif, 'jpg')));
      }
    }
    var rv = p.secure_media && p.secure_media.reddit_video;
    if (rv && rv.fallback_url) files.push(file(rv.fallback_url, 'video', 'mp4'));
    if (!files.length && p.url_overridden_by_dest && /\.(jpe?g|png|gif|webp|mp4)(\?|$)/i.test(p.url_overridden_by_dest)) {
      var e = extOf(p.url_overridden_by_dest, 'jpg'); files.push(file(p.url_overridden_by_dest, kindOfExt(e), e));
    }
    if (!files.length) return { fail: 'bài không có media' };
    return { res: { title: p.title || '', opts: listOptions(files) } };
  };

  P.og = function (st, resp) {
    if (st.step === 0) {
      st.step = 1;
      return { req: { url: st.src, headers: { 'User-Agent': UA.iphone, 'Accept': 'text/html' },
        grep: '<meta[^>]+(?:property|name)="(?:og:video(?::secure_url|:url)?|og:image(?::secure_url)?|twitter:player:stream|og:url)"[^>]*>|<(?:video|source)[^>]+src="[^"]+"|<link[^>]+rel="canonical"[^>]*>|https?:(?:\\\\?/){2}[^"\'\\s<>]*(?:tiktok|douyin|instagram|facebook|fb\\.watch|youtu|twitter|x\\.com|threads|xiaohongshu|reddit)[^"\'\\s<>]*' } };
    }
    var s = String(resp || ''), vids = [], imgs = [], m;
    var re = /<meta[^>]+(?:property|name)="(og:video(?::secure_url|:url)?|og:image(?::secure_url)?|twitter:player:stream)"[^>]*>/g;
    while ((m = re.exec(s))) {
      var c = /content="([^"]+)"/.exec(m[0]);
      if (!c) continue;
      var u = htmlUnescape(c[1]);
      if (!/^https?:/.test(u)) continue;
      if (/video|stream/.test(m[1])) vids.push(file(u, 'video', extOf(u, 'mp4'))); else imgs.push(file(u, 'image', extOf(u, 'jpg')));
    }
    var re2 = /<(?:video|source)[^>]+src="([^"]+)"/g;
    while ((m = re2.exec(s))) { var u2 = htmlUnescape(m[1]); if (/^https?:/.test(u2) && !/^blob:/.test(u2)) vids.push(file(u2, 'video', extOf(u2, 'mp4'))); }
    vids = uniq(vids, function (f) { return f.url; }).filter(function (f) { return !/\.m3u8|\.mpd/i.test(f.url); });
    imgs = uniq(imgs, function (f) { return f.url; });
    // link rút gọn / trang trung gian -> tìm link gốc thuộc nền tảng đã biết rồi xử lý lại
    if (!st.rr && st.plat === 'other') {
      var strong = [], weak = [], mm, hc;
      var reC = /<meta[^>]+property="og:url"[^>]*>|<link[^>]+rel="canonical"[^>]*>/g;
      while ((mm = reC.exec(s))) { hc = /(?:content|href)="([^"]+)"/.exec(mm[0]); if (hc) strong.push(htmlUnescape(hc[1])); }
      var reA = /https?:(?:\\?\/){2}[^"'\s<>]+/g;
      while ((mm = reA.exec(s))) weak.push(htmlUnescape(mm[0].replace(/\\\//g, '/')));
      var pick = function (list, needPost) {
        for (var ci = 0; ci < list.length; ci++) {
          var cu = list[ci].replace(/[),.;!?]+$/, ''), cp = detect(cu);
          if (cp !== 'other' && cp !== 'direct' && cu !== st.src && MAIN_HOST_RE.test(hostOf(cu)) && (!needPost || urlScore(cu) >= 3)) return cu;
        }
        return '';
      };
      var to = pick(strong, false) || (vids.length ? '' : pick(weak, true));
      if (to) return { reroute: to };
    }
    var files = vids.length ? vids : imgs.slice(0, 1);
    if (!files.length) return { fail: 'trang không có video/ảnh công khai ' + (st._raw || '') };
    return { res: { title: '', opts: listOptions(files) } };
  };

  /* ============================== BỘ ĐIỀU PHỐI ============================== */
  function encState(st) { return b64e(JSON.stringify(st)); }

  function outError(msg) { return { action: 'error', message: msg }; }

  function outFetch(st, req) {
    var h = {}, k;
    for (k in (req.headers || {})) if (req.headers.hasOwnProperty(k) && req.headers[k] !== '' && req.headers[k] !== undefined) h[k] = String(req.headers[k]);
    var hasUA = false;
    for (k in h) if (/^user-agent$/i.test(k)) hasUA = true;
    if (!hasUA) h['User-Agent'] = UA.chrome;
    var keys = Object.keys(h).slice(0, 8);
    var lower = keys.map(function (x) { return x.toLowerCase(); });
    var filler = [['Accept-Language', 'en-US,en;q=0.9'], ['DNT', '1'], ['Sec-GPC', '1'], ['Cache-Control', 'no-cache'], ['Pragma', 'no-cache'],
      ['X-Bhn-Snap', '1'], ['X-Bhn-Snap-2', '1'], ['X-Bhn-Snap-3', '1']];
    st.g = CONFIG.useGrep ? '' : (req.grep || '');
    var out = { action: 'fetch', url: req.url, method: (req.method || 'GET').toUpperCase(), body: req.body || '', grep: CONFIG.useGrep ? (req.grep || '') : '', st: encState(st) };
    var fi = 0;
    for (var i = 0; i < 8; i++) {
      var key, val;
      if (i < keys.length) { key = keys[i]; val = h[key]; }
      else {
        while (fi < filler.length && lower.indexOf(filler[fi][0].toLowerCase()) >= 0) fi++;
        key = filler[fi][0]; val = filler[fi][1]; fi++;
      }
      out['h' + (i + 1) + 'k'] = key;
      out['h' + (i + 1) + 'v'] = val;
    }
    return out;
  }

  function finalize(st, option) {
    var files = option.files || [];
    var stamp = Date.now().toString(36);
    var base = 'BHNSnap_' + st.plat + '_' + String(st.id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
    var out = [], nPhoto = 0, nFile = 0;
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var ext = f.ext || extOf(f.url, f.kind === 'audio' ? 'mp3' : f.kind === 'image' ? 'jpg' : 'mp4');
      var name = base + '_' + stamp + (files.length > 1 ? '_' + (i + 1) : '') + '.' + ext;
      if (f.kind === 'audio') nFile++; else nPhoto++;
      out.push({ url: f.url, name: name, kind: f.kind, ua: f.ua || UA.chrome, ref: f.ref || originOf(f.url) });
    }
    var parts = [];
    if (nPhoto) parts.push(nPhoto + ' tệp vào Ảnh');
    if (nFile) parts.push(nFile + ' tệp âm thanh vào Tệp › Phím tắt');
    return { action: 'done', files: out, count: out.length,
      message: 'Đã lưu ' + parts.join(', ') + ' (' + (PLATFORM_NAMES[st.plat] || st.plat) + ').' };
  }

  function present(st, res, cfg) {
    var opts = (res.opts || []).filter(function (o) { return (o.files && o.files.length) || o.again; });
    if (!opts.length) return null;
    st.title = res.title || st.title || '';
    var defOpt = opts.filter(function (o) { return o.def && o.files.length; })[0] || opts.filter(function (o) { return o.files.length; })[0];
    var ask = isTrue(cfg.ask, true);
    if (opts.length === 1 || !ask) {
      if (!defOpt) return null;
      return finalize(st, defOpt);
    }
    // đảm bảo nhãn không trùng
    var seen = {};
    for (var i = 0; i < opts.length; i++) { var l = opts[i].label; while (seen[l]) l += ' '; seen[l] = 1; opts[i].label = l; }
    st.phase = 'menu';
    st.opts = opts;
    st.lastPi = st.pi;
    var t = trim(st.title).replace(/\s+/g, ' ');
    if (t.length > 60) t = t.slice(0, 57) + '…';
    return { action: 'menu', title: (PLATFORM_NAMES[st.plat] || '') + (t ? ' · ' + t : '') + '\nChọn nội dung muốn tải:',
      options: opts.map(function (o) { return o.label; }), st: encState(st) };
  }

  function failMessage(st) {
    var lines = ['Không tải được link ' + (PLATFORM_NAMES[st.plat] || '') + ' này.'];
    var su = String(st.src || ''); if (su.length > 70) su = su.slice(0, 67) + '…';
    lines.push('Link: ' + su + (st.rr ? ' (từ ' + String(st.rr).slice(0, 40) + ')' : '') + (st.nu > 1 ? ' [chọn 1/' + st.nu + ' link được chia sẻ]' : ''));
    for (var i = 0; i < st.errs.length && i < 8; i++) lines.push('• ' + st.errs[i]);
    lines.push('Bài có thể riêng tư/đã xoá, hoặc API vừa đổi. Cập nhật engine.js rồi thử lại.');
    lines.push('Engine ' + ENGINE_VERSION);
    return lines.join('\n');
  }

  function drive(st, resp, cfg) {
    st._raw = '';
    if (resp && st.g) { st._raw = snip(resp); resp = localGrep(resp, st.g); }
    st.g = '';
    for (var guard = 0; guard < 40; guard++) {
      if (st.pi >= st.chain.length) return outError(failMessage(st));
      var name = st.chain[st.pi], p = P[name], r;
      if (!p) r = { fail: 'provider không tồn tại' };
      else {
        try { r = p(st, st.step === 0 ? null : resp, cfg) || { fail: 'không có kết quả' }; }
        catch (e) { r = { fail: 'lỗi xử lý: ' + (e && e.message ? e.message : e) }; }
      }
      if (r.req) return outFetch(st, r.req);
      if (r.reroute) {
        st.errs.push(name + ': chuyển sang ' + hostOf(r.reroute));
        st.rr = st.src; st.src = r.reroute; st.plat = detect(r.reroute);
        st.chain = (CONFIG.routes[st.plat] || CONFIG.routes.other).slice();
        st.pi = 0; st.step = 0; st.d = {}; resp = null;
        continue;
      }
      if (r.res) {
        var o = present(st, r.res, cfg);
        if (o) return o;
        r = { fail: 'không có tệp hợp lệ' };
      }
      st.errs.push(name + ': ' + r.fail);
      st.pi++; st.step = 0; st.d = {}; resp = null;
    }
    return outError(failMessage(st));
  }

  function onMenu(st, resp, cfg) {
    var pick = trim(resp);
    var opts = st.opts || [], chosen = null;
    for (var i = 0; i < opts.length; i++) if (trim(opts[i].label) === pick) { chosen = opts[i]; break; }
    if (!chosen) return outError('Không nhận được lựa chọn.');
    st.phase = 'api'; st.opts = null;
    if (chosen.again) {
      st.mode = chosen.again; st.step = 0; st.d = {}; st.pi = st.lastPi || 0;
      return drive(st, null, cfg);
    }
    return finalize(st, chosen);
  }

  function run(env) {
    var cfg = parseJSON(env.C) || {};
    if ((+env.V || 0) < MIN_SHORTCUT_VERSION) return outError('Phím tắt BHN Snap đã cũ, hãy cài bản mới.');
    var st = env.S ? parseJSON(env.d(env.S)) : null;
    var resp = env.R ? env.d(env.R) : '';
    if (!st) {
      var src = extractUrl(env.I);
      if (!src) return outError('Chưa có link. Hãy sao chép link video / ảnh rồi chạy lại BHN Snap (hoặc dán link vào ô nhập).');
      var plat = detect(src);
      st = { v: 1, src: src, plat: plat, pi: 0, step: 0, d: {}, errs: [], mode: 'auto', phase: 'api', id: '', nu: extractUrl.n || 1 };
      if (isTrue(cfg.audio_only, false)) st.mode = 'audio';
      if (plat === 'direct') {
        var e = extOf(src, 'mp4');
        return finalize(st, opt('direct', [file(src, kindOfExt(e), e)], true));
      }
      st.chain = (CONFIG.routes[plat] || CONFIG.routes.other).slice();
      return drive(st, null, cfg);
    }
    if (st.phase === 'menu') return onMenu(st, resp, cfg);
    return drive(st, resp, cfg);
  }

  return { run: run, version: ENGINE_VERSION, _P: P, _detect: detect, _extractUrl: extractUrl, CONFIG: CONFIG };
})();
