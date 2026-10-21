/* Логика прототипа «Помню»: маршруты, разговор с агентом (имитация записи и обработки),
   сборка главы, люди / места и события. Данные — assets/data.js. */
(function () {
  'use strict';

  const D = window.POMNU;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* ---------- утилиты ---------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const escRe = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const icon = (id, cls = '') => `<svg class="ico ${cls}" aria-hidden="true" focusable="false"><use href="#${id}"></use></svg>`;
  const agentDot = '<span class="agent-dot" aria-hidden="true"><svg viewBox="0 0 24 24"><use href="#logo-bars"></use></svg></span>';
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const arr = (v) => (Array.isArray(v) ? v : []);
  function plural(n, one, few, many) {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    if (b === 1) return one;
    return many;
  }
  const fmtTime = (sec) => { const s = Math.max(0, Math.round(sec)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const parseDur = (d) => { const p = String(d || '0:00').split(':').map(Number); return (p[0] || 0) * 60 + (p[1] || 0); };
  const initials = (e) => {
    const caps = e.name.split(/\s+/).filter((w) => /^[А-ЯЁA-Z]/.test(w));
    return caps.length ? caps.slice(0, 2).map((w) => w[0]).join('') : e.name.charAt(0).toUpperCase();
  };
  const TOK = /\[\[(p|l):([^|\]]+)\|([^\]]+)\]\]/g;
  const plain = (str) => String(str).replace(TOK, '$3');

  /* ---------- состояние ---------- */
  function newTalk(session) {
    return { session, pos: 0, turns: [], rec: 'idle', photo: null, photoQ: null, draft: '', dur: 0, step: 0, failed: false, recStart: 0 };
  }
  const S = {
    stories: D.stories.map((s) => Object.assign(clone(s), { demo: true, talk: newTalk(s.sessions.length + 1) })),
    people: clone(D.people),
    places: clone(D.places),
    events: clone(D.events),
    sources: clone(D.sources),
    chapters: clone(D.chapters),
    fresh: new Set(),
    filter: 'all',
    scroll: {},
    edit: false,
    editing: null,
    slot: null,
    route: { view: 'home' },
    first: true,
    qEnter: false,
    lastFocus: null,
    timers: {}
  };
  const C = { step: 1, photo: null }; // мастер создания истории

  /* ---------- выборки ---------- */
  const getStory = (id) => S.stories.find((s) => s.id === id);
  const typeOf = (s) => D.types[s.type];
  const list = (obj, sid) => Object.keys(obj).filter((id) => obj[id].story === sid).map((id) => Object.assign({ id }, obj[id]));
  const storyPeople = (sid) => list(S.people, sid);
  const storyPlaces = (sid) => list(S.places, sid);
  const storySources = (sid) => list(S.sources, sid).sort((a, b) => a.session - b.session || a.n - b.n);
  const storyEvents = (sid) => S.events.filter((e) => e.story === sid).sort((a, b) => (a.sort || 9999) - (b.sort || 9999));
  const srcLabel = (id) => { const x = S.sources[id]; return x ? `Ответ ${x.n} · сессия ${x.session}` : ''; };
  function mentions(kind, id) {
    const e = kind === 'p' ? S.people[id] : S.places[id];
    if (!e) return [];
    const srcs = storySources(e.story);
    if (kind === 'p' && e.narrator) return srcs;
    return srcs.filter((x) => (kind === 'p' ? arr(x.people) : arr(x.places)).includes(id));
  }
  /* id сущности из сценария: существующий — как есть, новый в новой истории — с префиксом истории */
  function rid(s, id) {
    if (S.people[id] || S.places[id]) return id;
    return s.demo ? id : `${s.id}-${id}`;
  }
  const narratorLine = (s) => (s.relation === 'я' ? 'Рассказываете вы' : `Рассказывает ${s.narrator}${s.relation ? ` · ${s.relation}` : ''}`);
  const sessionsWord = (s) => { const n = s.sessions.length; return n ? `${n} ${plural(n, 'сессия', 'сессии', 'сессий')} разговора` : 'первая сессия'; };
  const scriptOf = (s) => D.scripts[s.demo ? s.id : s.type] || [];

  function currentQuestion(s) {
    const t = s.talk;
    if (t.photoQ) return t.photoQ;
    const script = scriptOf(s);
    while (t.pos < script.length) {
      const q = script[t.pos];
      const topic = s.topics.find((x) => x.id === q.topic);
      const missing = q.requires && !S.people[rid(s, q.requires)];
      if (missing || (topic && topic.status === 'declined')) { t.pos += 1; continue; }
      return q;
    }
    return null;
  }
  const answerFor = (s, q) => (s.talk.photoQ ? D.photoAnswers[s.demo ? s.id : s.type] : q.answer);

  function setTopic(s, id, status, title) {
    let tp = s.topics.find((x) => x.id === id);
    if (!tp) { tp = { id, title: title || 'Тема', status }; s.topics.push(tp); return; }
    if (tp.status === 'declined' && status !== 'declined') return;
    tp.status = status;
  }
  function activateNextTopic(s) {
    const q = currentQuestion(s);
    if (!q || !q.topic) return;
    const tp = s.topics.find((x) => x.id === q.topic);
    if (!tp || (tp.status !== 'done' && tp.status !== 'declined')) setTopic(s, q.topic, 'current', q.topicTitle);
  }
  function contNote(s) {
    if (s.continueNote && !s.noteStale) return s.continueNote;
    const tp = s.topics.find((x) => x.status === 'current') || s.topics.find((x) => x.status === 'later');
    return tp ? `Следующая тема — «${tp.title}». Агент помнит всё, что уже рассказано.` : 'Все отмеченные темы рассказаны. Можно начать новую тему или собрать главу.';
  }

  /* ---------- общие кусочки разметки ---------- */
  function navHTML(active) {
    const items = S.stories.map((s) => {
      const T = typeOf(s);
      return `<li><a class="nav-item t-${s.type}" href="#/s/${s.id}/talk"${active === s.id ? ' aria-current="page"' : ''}><span class="tdot">${icon(T.icon, 'ico-sm')}</span><span class="od-truncate">${esc(s.title)}</span></a></li>`;
    }).join('');
    return `
      <a class="brand" href="#/" aria-label="Помню — на главную"><svg class="logo" aria-hidden="true"><use href="#logo"></use></svg><span>Помню</span></a>
      <nav aria-label="Основная навигация">
        <ul class="nav">
          <li><a class="nav-item" href="#/"${active === 'home' ? ' aria-current="page"' : ''}>${icon('i-home')}<span>Главная</span></a></li>
        </ul>
      </nav>
      <div>
        <p class="nav-label">Истории</p>
        <ul class="nav-list">${items}</ul>
      </div>
      <div class="nav-foot">
        <button class="btn btn-primary btn-block" type="button" data-action="create">${icon('i-plus')}<span>Новая история</span></button>
        <div class="me">
          <span class="avatar avatar-sm t-neutral" aria-hidden="true">${esc(D.user.initials)}</span>
          <span class="od-field"><span class="me-name">${esc(D.user.fullName)}</span><span class="me-sub">Личный архив</span></span>
        </div>
      </div>`;
  }
  function srcChip(id, frag) {
    if (!S.sources[id]) return '';
    return `<button class="src-chip" type="button" data-action="source" data-src="${esc(id)}"${frag ? ` data-frag="${esc(frag)}"` : ''}>${icon('i-mic', 'ico-sm')}<span>${esc(srcLabel(id))}</span></button>`;
  }
  function voiceBtn(key, dur, name) {
    return `<button class="voice" type="button" data-action="play" data-key="${esc(key)}" data-dur="${esc(dur)}" aria-pressed="false" aria-label="${esc(name)}, ${esc(dur)}"><span class="pp">${icon('i-play', 'ico-sm')}</span><span class="voice-txt"><span class="v-name">${esc(name)}</span><span class="v-dur">${esc(dur)}</span></span><span class="voice-track" aria-hidden="true"><i></i></span></button>`;
  }
  const whoBtn = (s, id) => {
    const p = S.people[id];
    return `<button class="who" type="button" data-action="person" data-id="${esc(id)}"><span class="avatar t-${s.type}" aria-hidden="true">${esc(initials(p))}</span><span>${esc(p.name)}</span></button>`;
  };
  const placeBtn = (s, id) => {
    const p = S.places[id];
    return `<button class="who" type="button" data-action="place" data-id="${esc(id)}"><span class="avatar avatar-place t-${s.type}" aria-hidden="true">${icon('i-pin', 'ico-sm')}</span><span>${esc(p.name)}</span></button>`;
  };
  function renderTokens(str) {
    return esc(str).replace(TOK, (m, k, id, label) => {
      const ok = k === 'p' ? S.people[id] : S.places[id];
      if (!ok) return label;
      return `<button type="button" class="mention${k === 'l' ? ' is-place' : ''}" data-action="mention" data-kind="${k}" data-id="${id}" aria-haspopup="dialog" aria-expanded="false">${label}</button>`;
    });
  }
  const approxDate = (e) => `${e.approx && e.sort ? '≈ ' : ''}${e.date}`;

  /* ---------- главная ---------- */
  function greeting() {
    const h = new Date().getHours();
    if (h < 5) return 'Доброй ночи';
    if (h < 12) return 'Доброе утро';
    if (h < 18) return 'Добрый день';
    return 'Добрый вечер';
  }
  function storyCardHTML(s) {
    const T = typeOf(s);
    const nEnt = T.primary === 'places' ? storyPlaces(s.id).length : storyPeople(s.id).length;
    const entWord = T.primary === 'places' ? plural(nEnt, 'место', 'места', 'мест') : plural(nEnt, 'человек', 'человека', 'человек');
    const ns = s.sessions.length;
    const nc = s.chapters.length;
    const cover = s.cover
      ? `<img class="od-media od-media-cover" style="--od-ratio:16/10" src="${esc(s.cover.src)}" width="${s.cover.w}" height="${s.cover.h}" alt="" loading="lazy">`
      : `<div class="type-cover">${icon(T.icon)}</div>`;
    return `<a class="story-card t-${s.type}" href="#/s/${s.id}/talk">
      <div class="story-cover">${cover}<span class="tbadge">${icon(T.icon, 'ico-sm')}${esc(T.label)}</span></div>
      <div class="story-body">
        <h3 class="od-clamp-2">${esc(s.title)}</h3>
        <p class="story-meta">${esc(narratorLine(s))}</p>
        <div class="story-foot">
          <span class="pill">${ns ? `${ns} ${plural(ns, 'сессия', 'сессии', 'сессий')}` : 'Без сессий'}</span>
          <span class="pill">${nc} ${plural(nc, 'глава', 'главы', 'глав')}</span>
          <span class="pill">${nEnt} ${entWord}</span>
        </div>
        <p class="story-meta">Обновлено ${esc(s.updated)}</p>
      </div>
    </a>`;
  }
  function homeHTML() {
    const cont = S.stories.find((s) => s.continueNote);
    const counts = { all: S.stories.length };
    Object.keys(D.types).forEach((k) => { counts[k] = S.stories.filter((s) => s.type === k).length; });
    const shown = S.filter === 'all' ? S.stories : S.stories.filter((s) => s.type === S.filter);
    const chips = [['all', 'Все']].concat(Object.keys(D.types).map((k) => [k, D.types[k].plural]))
      .map(([k, label]) => `<button class="chip" type="button" data-action="filter" data-type="${k}" aria-pressed="${S.filter === k}"><span>${esc(label)}</span><span class="n">${counts[k]}</span></button>`).join('');

    let grid;
    if (shown.length) {
      grid = `<div class="story-grid">${shown.map(storyCardHTML).join('')}
        <button class="new-tile" type="button" data-action="create"${S.filter !== 'all' ? ` data-type="${S.filter}"` : ''}><span class="plus">${icon('i-plus')}</span><strong>Новая история</strong><span class="help">Агент задаст первый вопрос</span></button>
      </div>`;
    } else {
      const T = D.types[S.filter];
      grid = `<div class="empty-card t-${S.filter}">
        <span class="type-ico">${icon(T.icon)}</span>
        <h3>Историй в разделе «${esc(T.plural)}» пока нет</h3>
        <p class="help">Агент начнёт с вопроса: «${esc(D.scripts[S.filter][0].text)}»</p>
        <button class="btn btn-primary" type="button" data-action="create" data-type="${S.filter}">${icon('i-plus')}<span>Начать историю</span></button>
      </div>`;
    }

    const contHTML = cont ? `
      <section class="continue" aria-labelledby="contTitle">
        <div class="continue-media"><img src="${esc(cont.cover.src)}" width="${cont.cover.w}" height="${cont.cover.h}" alt="${esc(cont.cover.alt)}"></div>
        <div class="continue-body">
          <p class="eyebrow">Продолжить разговор · ${esc(typeOf(cont).label)}</p>
          <h2 id="contTitle">${esc(cont.title)}</h2>
          <div class="agent-note">${agentDot}<p>${esc(contNote(cont))}</p></div>
          <div class="od-cluster">
            <a class="btn btn-primary" href="#/s/${cont.id}/talk">${icon('i-mic')}<span>Продолжить разговор</span></a>
            <a class="btn btn-secondary" href="#/s/${cont.id}/chapter">${icon('i-book')}<span>Открыть главы</span></a>
          </div>
        </div>
      </section>` : '';

    const typesHTML = Object.keys(D.types).map((k) => {
      const T = D.types[k];
      return `<button class="type-card t-${k}" type="button" data-action="create" data-type="${k}"><span class="type-ico">${icon(T.icon)}</span><span class="type-name">${esc(T.label)}</span><span class="type-hint">${esc(T.hint)}</span><span class="type-go">Начать${icon('i-arrow-right', 'ico-sm')}</span></button>`;
    }).join('');

    return `<div class="page">
      <header class="home-head">
        <p class="eyebrow">${greeting()}, ${esc(D.user.name)}</p>
        <h1 class="display" tabindex="-1">Истории, которые стоит сохранить</h1>
        <p class="lead">Рассказывайте голосом — агент задаст вопросы, найдёт людей, места и события и соберёт из ответов главы.</p>
      </header>
      ${contHTML}
      <section class="section" aria-labelledby="storiesTitle">
        <div class="section-head">
          <h2 id="storiesTitle">Ваши истории</h2>
          <div class="filters od-rail" role="group" aria-label="Фильтр по типу истории">${chips}</div>
        </div>
        ${grid}
      </section>
      <section class="section" aria-labelledby="typesTitle">
        <div class="section-head">
          <div><h2 id="typesTitle">Начать новую историю</h2><p class="help">Выберите тему — агент подстроит вопросы и то, что ищет в рассказе.</p></div>
        </div>
        <div class="type-grid">${typesHTML}</div>
      </section>
    </div>`;
  }

  /* ---------- история: шапка и вкладки ---------- */
  function storyHTML(r) {
    const s = getStory(r.sid);
    const T = typeOf(s);
    const tabs = [
      ['talk', 'i-mic', 'Разговор'],
      ['chapter', 'i-book', 'Главы'],
      ['archive', T.primary === 'places' ? 'i-pin' : 'i-users', T.archive]
    ];
    const tabsHTML = tabs.map(([v, ic, label]) => `<a class="tab" href="#/s/${s.id}/${v}"${r.view === v ? ' aria-current="page"' : ''}>${icon(ic)}<span>${esc(label)}</span></a>`).join('');
    let body;
    if (r.view === 'chapter') body = chapterHTML(s, r.sub);
    else if (r.view === 'archive') body = archiveHTML(s, r.sub);
    else body = talkHTML(s);
    return `<div class="page">
      <header class="story-head">
        <nav class="crumbs" aria-label="Путь"><a href="#/">Главная</a>${icon('i-chevron-right', 'ico-sm')}<span>${esc(T.plural)}</span></nav>
        <div class="od-stack" style="--od-gap:12px">
          <span class="tbadge t-${s.type}">${icon(T.icon, 'ico-sm')}${esc(T.label)}</span>
          <h1 tabindex="-1">${esc(s.title)}</h1>
          <p class="story-sub">${esc(narratorLine(s))} · ${esc(sessionsWord(s))}</p>
        </div>
        <nav class="tabs" aria-label="Разделы истории">${tabsHTML}</nav>
      </header>
      ${body}
    </div>`;
  }

  /* ---------- разговор ---------- */
  const STEPS = ['Запись сохранена', 'Расшифровываем речь', 'Ищем людей, места и события', 'Подбираем следующий вопрос'];
  const locked = (t) => t.rec !== 'idle' && t.rec !== 'typing';

  function talkHTML(s) {
    const t = s.talk;
    const q = currentQuestion(s);
    const answered = t.turns.filter((x) => x.src).length;
    const dis = locked(t) ? ' disabled' : '';
    const actions = `
      <div class="talk-actions">
        ${q ? `<button class="btn btn-ghost" type="button" data-action="skip"${dis}>${icon('i-skip')}<span>Пропустить</span></button>
        <button class="btn btn-ghost" type="button" data-action="decline"${dis}>${icon('i-minus-circle')}<span>Не хочу обсуждать</span></button>` : ''}
        <button class="btn btn-ghost" type="button" data-action="attach"${dis}>${icon('i-image')}<span>${t.photo ? 'Заменить фото' : 'Прикрепить фото'}</span></button>
        <div class="finish-wrap">
          <button class="btn btn-primary" type="button" data-action="finish"${answered && !locked(t) ? '' : ' disabled'}${answered ? '' : ' aria-describedby="finishHelp"'}>${icon('i-book')}<span>Завершить и собрать главу</span></button>
          ${answered ? '' : '<p class="help" id="finishHelp">Ответьте хотя бы на один вопрос — тогда из разговора получится глава.</p>'}
        </div>
      </div>`;
    return `<div class="talk">
      <div class="talk-main">
        ${sessionBarHTML(s)}
        ${t.turns.length ? `<ol class="turns" aria-label="Ответы этой сессии">${t.turns.map((tu, i) => turnHTML(tu, i)).join('')}</ol>` : ''}
        ${q ? questionHTML(s, q) : doneHTML(s)}
        ${actions}
      </div>
      ${materialsHTML(s)}
    </div>`;
  }

  function sessionBarHTML(s) {
    const t = s.talk;
    const answered = t.turns.filter((x) => x.src).length;
    const pend = s.clarify.filter((c) => !c.resolved).length;
    const ns = s.sessions.length;
    let sub;
    if (answered) sub = `${answered} ${plural(answered, 'ответ', 'ответа', 'ответов')} в этой сессии`;
    else if (ns) sub = `Агент помнит ${ns} ${plural(ns, 'прошлую сессию', 'прошлые сессии', 'прошлых сессий')} и незаконченные темы`;
    else sub = 'Первая сессия — агент начнёт с главного';
    const past = ns ? `<details class="past">
        <summary>${icon('i-chevron-down')}<span>Прошлые сессии</span></summary>
        <ul>${s.sessions.slice().reverse().map((se) => {
          const srcs = storySources(s.id).filter((x) => x.session === se.n);
          return `<li><span><strong>Сессия ${se.n}</strong> · ${esc(se.date)} · ${srcs.length} ${plural(srcs.length, 'ответ', 'ответа', 'ответов')}</span><div class="od-cluster">${srcs.map((x) => `<button class="src-chip" type="button" data-action="source" data-src="${esc(x.id)}">${icon('i-mic', 'ico-sm')}<span>Ответ ${x.n}</span></button>`).join('')}</div></li>`;
        }).join('')}</ul>
      </details>` : '';
    return `<div class="session-bar">
      <div class="od-field"><span class="session-title">Сессия ${t.session} · сегодня</span><span class="help">${esc(sub)}</span></div>
      <button class="btn btn-secondary btn-sm mat-jump" type="button" data-action="jump-materials">${icon('i-users')}<span>${pend ? `Материалы · уточнить ${pend}` : 'Материалы'}</span></button>
      ${past}
    </div>`;
  }

  function turnHTML(tu, i) {
    if (!tu.src) {
      return `<li class="turn is-muted"><p class="turn-q"><span class="turn-n">Вопрос ${i + 1}</span><span>${esc(tu.q)}</span></p><p class="turn-st">${icon(tu.declined ? 'i-minus-circle' : 'i-skip', 'ico-sm')}<span>${tu.declined ? 'Не обсуждаем — агент не вернётся к этой теме' : 'Пропущено — тема осталась в списке незаконченных'}</span></p></li>`;
    }
    const x = S.sources[tu.src];
    return `<li class="turn">
      <p class="turn-q"><span class="turn-n">Вопрос ${i + 1}</span><span>${esc(tu.q)}</span></p>
      <div class="turn-a">
        ${x.photo ? `<img class="turn-photo" src="${esc(x.photo.src)}" width="${x.photo.w}" height="${x.photo.h}" alt="Фото, приложенное к ответу">` : ''}
        <p class="od-clamp-3">${esc(x.text)}</p>
        <div class="od-cluster">${x.typed ? '<span class="help">Ответ текстом</span>' : voiceBtn(`turn-${tu.src}`, x.dur, 'Ваш ответ')}<button class="btn btn-ghost btn-xs" type="button" data-action="source" data-src="${esc(tu.src)}">Открыть ответ</button></div>
      </div>
    </li>`;
  }

  function questionHTML(s, q) {
    const t = s.talk;
    const topic = q.topic ? s.topics.find((x) => x.id === q.topic) : null;
    const label = t.photoQ ? 'Вопрос по фото' : (topic ? topic.title : (q.topicTitle || ''));
    const photo = t.photoQ && t.photo ? `<figure class="q-photo"><img class="od-media" src="${esc(t.photo.src)}" width="${t.photo.w}" height="${t.photo.h}" alt="Фото, которое вы прикрепили к разговору"><figcaption><span>Прикреплённое фото</span><button class="link-btn" type="button" data-action="remove-photo"${locked(t) ? ' disabled' : ''}>Убрать</button></figcaption></figure>` : '';
    return `<section class="qcard${S.qEnter ? ' is-entering' : ''}" aria-labelledby="qText">
      <div class="q-meta">${agentDot}<span>Вопрос ${t.turns.length + 1}</span><span aria-hidden="true">·</span><span>${esc(label)}</span></div>
      <h2 class="q-text" id="qText" tabindex="-1">${esc(q.text)}</h2>
      ${q.why ? `<p class="q-why">${icon('i-info', 'ico-sm')}<span>Почему спрашиваю: ${esc(q.why)}</span></p>` : ''}
      ${photo}
      <div class="q-tools"><button class="btn btn-secondary btn-sm" type="button" data-action="speak" aria-pressed="false">${icon('i-volume')}<span>Прослушать вопрос</span></button></div>
      <div class="recorder" id="recorder" tabindex="-1">${recorderHTML(s)}</div>
    </section>`;
  }

  function doneHTML(s) {
    const any = s.talk.turns.some((x) => x.src);
    return `<section class="qcard" aria-labelledby="qText">
      <div class="q-meta">${agentDot}<span>Агент</span></div>
      <h2 class="q-text" id="qText" tabindex="-1">На сегодня вопросов больше нет</h2>
      <p class="help">${any ? 'Соберите главу из ответов этой сессии — или прикрепите фото, и агент спросит о нём.' : 'Прикрепите фото, и агент спросит о нём, — или вернитесь к разговору позже.'}</p>
    </section>`;
  }

  function stepsHTML(steps, k, label) {
    return `<ol class="steps" aria-label="${esc(label)}">${steps.map((l, i) => {
      const st = i < k ? 'done' : i === k ? 'active' : 'wait';
      const sr = st === 'done' ? 'готово' : st === 'active' ? 'выполняется' : 'ожидает';
      return `<li class="step is-${st}"><span class="step-ico" aria-hidden="true">${st === 'done' ? icon('i-check', 'ico-sm') : ''}</span><span>${esc(l)}</span><span class="visually-hidden"> — ${sr}</span></li>`;
    }).join('')}</ol>`;
  }

  function recorderHTML(s) {
    const t = s.talk;
    if (t.rec === 'recording') {
      return `<div class="rec-row">
          <button class="rec-btn is-recording" type="button" data-action="rec-stop" aria-label="Остановить запись">${icon('i-stop')}</button>
          <div class="od-field" style="--od-gap:6px"><span class="live-dot">Идёт запись</span><span class="timer" id="recTimer">0:00</span></div>
          <div class="levels" id="levels" aria-hidden="true">${'<i></i>'.repeat(28)}</div>
        </div>
        <div class="rec-foot"><button class="btn btn-ghost btn-sm" type="button" data-action="rec-cancel">${icon('i-x')}<span>Отменить запись</span></button></div>`;
    }
    if (t.rec === 'processing') {
      const steps = STEPS.slice();
      steps[0] = `${STEPS[0]} · ${fmtTime(t.dur)}`;
      return stepsHTML(steps, t.step, 'Обработка ответа');
    }
    if (t.rec === 'error') {
      return `<div class="alert" role="alert">${icon('i-alert')}
        <div class="od-stack" style="--od-gap:4px">
          <strong>Не получилось расшифровать запись</strong>
          <span>Запись сохранена (${fmtTime(t.dur)}) — ничего не потерялось. Попробуйте расшифровать ещё раз или запишите ответ заново.</span>
          <div class="od-cluster" style="margin-top:8px">
            <button class="btn btn-primary btn-sm" type="button" data-action="rec-retry">${icon('i-refresh')}<span>Повторить расшифровку</span></button>
            <button class="btn btn-secondary btn-sm" type="button" data-action="rec-again">Записать заново</button>
          </div>
        </div>
      </div>`;
    }
    if (t.rec === 'review') {
      return `<div class="od-stack" style="--od-gap:16px">
        <div class="player">${voiceBtn('draft', fmtTime(t.dur), 'Прослушать ответ')}</div>
        <div class="field" style="margin:0">
          <label for="draft">Расшифровка</label>
          <p class="help" id="draftHelp">Проверьте текст и исправьте, если что-то распознано неверно. Запись останется в исходном виде.</p>
          <textarea class="input" id="draft" rows="5" aria-describedby="draftHelp">${esc(t.draft)}</textarea>
        </div>
        <div class="od-cluster">
          <button class="btn btn-primary" type="button" data-action="save-answer">${icon('i-check')}<span>Сохранить ответ</span></button>
          <button class="btn btn-ghost" type="button" data-action="rec-again">Записать заново</button>
        </div>
      </div>`;
    }
    if (t.rec === 'typing') {
      return `<div class="field" style="margin:0">
          <label for="typed">Ваш ответ</label>
          <p class="help" id="typedHelp">Напишите так, как рассказали бы вслух.</p>
          <textarea class="input" id="typed" rows="5" aria-describedby="typedHelp typedErr"></textarea>
          <p class="err" id="typedErr" hidden>${icon('i-alert', 'ico-sm')}<span>Напишите хотя бы пару слов — или вернитесь к записи голосом.</span></p>
        </div>
        <div class="od-cluster">
          <button class="btn btn-primary" type="button" data-action="save-typed">${icon('i-check')}<span>Сохранить ответ</span></button>
          <button class="btn btn-ghost" type="button" data-action="rec-idle">${icon('i-mic')}<span>Ответить голосом</span></button>
        </div>`;
    }
    return `<div class="rec-row">
        <button class="rec-btn" type="button" data-action="rec-start" aria-label="Записать ответ">${icon('i-mic')}</button>
        <div class="rec-text"><strong>Нажмите и расскажите</strong><span>Говорите сколько хочется — запись сохраняется сразу.</span></div>
      </div>
      <div class="rec-foot"><button class="btn btn-ghost btn-sm" type="button" data-action="rec-type">${icon('i-text')}<span>Ответить текстом</span></button></div>`;
  }

  function entRow(kind, e, s) {
    const av = kind === 'p'
      ? `<span class="avatar t-${s.type}" aria-hidden="true">${esc(initials(e))}</span>`
      : `<span class="avatar avatar-place t-${s.type}" aria-hidden="true">${icon('i-pin', 'ico-sm')}</span>`;
    return `<li><button class="ent-row" type="button" data-action="${kind === 'p' ? 'person' : 'place'}" data-id="${esc(e.id)}">${av}<span class="od-field od-fill"><span class="ent-name od-truncate">${esc(e.name)}</span><span class="ent-role od-truncate">${esc(e.role)}</span></span>${S.fresh.has(e.id) ? '<span class="pill pill-new">Новое</span>' : ''}</button></li>`;
  }

  function materialsHTML(s) {
    const T = typeOf(s);
    const freshFirst = (a, b) => Number(S.fresh.has(b.id)) - Number(S.fresh.has(a.id));
    const people = storyPeople(s.id).sort(freshFirst);
    const places = storyPlaces(s.id).sort(freshFirst);
    const allEvents = storyEvents(s.id);
    const evs = allEvents.slice().sort((a, b) => freshFirst(a, b) || (b.sort || 0) - (a.sort || 0)).slice(0, 4);
    const pending = s.clarify.filter((c) => !c.resolved);
    const done = s.clarify.filter((c) => c.resolved);

    const clar = `<section class="mat-sec" aria-labelledby="mc">
      <h3 id="mc" tabindex="-1">Нужно уточнить <span class="count">${pending.length}</span></h3>
      ${pending.length ? pending.map((c) => `<div class="clarify">
          <p>${esc(c.text)}</p>
          ${c.src && S.sources[c.src] ? `<span class="src-link">${srcChip(c.src)}</span>` : ''}
          <div class="od-cluster">
            <button class="btn btn-secondary btn-sm" type="button" data-action="clarify" data-id="${esc(c.id)}" data-v="yes">${esc(c.yes)}</button>
            <button class="btn btn-ghost btn-sm" type="button" data-action="clarify" data-id="${esc(c.id)}" data-v="no">${esc(c.no)}</button>
          </div>
        </div>`).join('') : '<p class="help">Сейчас уточнять нечего — все связи понятны.</p>'}
      ${done.length ? `<ul class="ent-list">${done.map((c) => `<li class="resolved">${icon('i-check', 'ico-sm')}<span>${esc(c.resolved === 'yes' ? c.yesMsg : c.noMsg)}</span></li>`).join('')}</ul>` : ''}
    </section>`;

    const secP = `<section class="mat-sec" aria-labelledby="mp"><h3 id="mp">Люди <span class="count">${people.length}</span></h3>
      ${people.length ? `<ul class="ent-list">${people.slice(0, 6).map((p) => entRow('p', p, s)).join('')}</ul>` : '<p class="help">Люди появятся, когда вы назовёте их в рассказе.</p>'}</section>`;
    const secL = `<section class="mat-sec" aria-labelledby="ml"><h3 id="ml">Места <span class="count">${places.length}</span></h3>
      ${places.length ? `<ul class="ent-list">${places.slice(0, 6).map((p) => entRow('l', p, s)).join('')}</ul>` : '<p class="help">Места появятся, когда в рассказе прозвучат город, улица или дом.</p>'}</section>`;
    const secE = `<section class="mat-sec" aria-labelledby="me"><h3 id="me">События <span class="count">${allEvents.length}</span></h3>
      ${evs.length ? `<ul class="ent-list">${evs.map((e) => `<li><a class="ent-row" href="#/s/${s.id}/archive/timeline"><span class="avatar avatar-place t-neutral" aria-hidden="true">${icon('i-calendar', 'ico-sm')}</span><span class="od-field od-fill"><span class="ent-name">${esc(e.title)}</span><span class="ent-role">${esc(approxDate(e))}${e.approx && e.sort ? ' · примерно' : ''}</span></span>${S.fresh.has(e.id) ? '<span class="pill pill-new">Новое</span>' : ''}</a></li>`).join('')}</ul>` : '<p class="help">События появятся после первых ответов.</p>'}</section>`;

    const ST = { current: ['i-mic', 'Сейчас'], later: ['i-clock', 'Позже'], done: ['i-check', 'Рассказано'], declined: ['i-minus-circle', 'Не обсуждаем'] };
    const order = { current: 0, later: 1, declined: 2, done: 3 };
    const topics = s.topics.slice().sort((a, b) => order[a.status] - order[b.status]);
    const secT = `<section class="mat-sec" aria-labelledby="mt"><h3 id="mt">Темы разговора</h3>
      ${topics.length ? `<ul class="topics">${topics.map((tp) => `<li class="topic is-${tp.status}">${icon(ST[tp.status][0], 'ico-sm')}<span class="topic-title">${esc(tp.title)}</span><span class="topic-st">${ST[tp.status][1]}</span></li>`).join('')}</ul>` : '<p class="help">Темы появятся после первого ответа.</p>'}</section>`;

    const ents = T.primary === 'places' ? secL + secP : secP + secL;
    return `<aside class="materials" id="materials" aria-labelledby="matTitle" tabindex="-1">
      <div class="mat-head"><h2 id="matTitle">Из разговора</h2><p class="help">Архивист обновляет список после каждого ответа. Похожих людей он не объединяет сам — спрашивает.</p></div>
      ${clar}${ents}${secE}${secT}
      <a class="btn btn-secondary btn-block" href="#/s/${s.id}/archive"><span>${esc(T.archive)}</span>${icon('i-arrow-right')}</a>
    </aside>`;
  }

  /* ---------- главы ---------- */
  function blockHTML(b, i, s, ch) {
    const key = `${ch.id}:${i}`;
    if (b.t === 'p') {
      if (S.editing === key) {
        return `<div class="blk is-editing">
          <label class="visually-hidden" for="ed">Текст абзаца</label>
          <textarea class="input read-input" id="ed" rows="6">${esc(plain(b.text))}</textarea>
          <div class="blk-tools">
            <button class="btn btn-primary btn-sm" type="button" data-action="save-blk" data-ch="${esc(ch.id)}" data-i="${i}">${icon('i-check')}<span>Сохранить</span></button>
            <button class="btn btn-ghost btn-sm" type="button" data-action="cancel-blk" data-ch="${esc(ch.id)}" data-i="${i}">Отмена</button>
          </div>
        </div>`;
      }
      return `<div class="blk">
        <p class="read">${renderTokens(b.text)}</p>
        ${b.note ? `<p class="note">${icon('i-info', 'ico-sm')}<span>${esc(b.note)}</span></p>` : ''}
        <div class="blk-tools">${srcChip(b.src)}${b.edited ? '<span class="edited">Изменено вами</span>' : ''}${S.edit ? `<button class="btn btn-ghost btn-xs" type="button" data-action="edit-blk" data-ch="${esc(ch.id)}" data-i="${i}">${icon('i-edit', 'ico-sm')}<span>Изменить абзац</span></button>` : ''}</div>
      </div>`;
    }
    if (b.t === 'quote') {
      const p = b.by ? S.people[b.by] : null;
      return `<figure class="pull">
        <blockquote><p>«${esc(b.text)}»</p></blockquote>
        <figcaption>
          <span class="pull-by"><span class="pull-name">${esc(p ? p.name : s.narrator)}</span>${b.byNote ? `<span class="pull-note">${esc(b.byNote)}</span>` : ''}</span>
          ${voiceBtn(`q-${ch.id}-${i}`, b.dur, 'Слушать запись')}
          ${srcChip(b.src, b.text)}
        </figcaption>
      </figure>`;
    }
    if (b.t === 'fig') {
      return `<figure class="photo"><img class="od-media" src="${esc(b.img.src)}" width="${b.img.w}" height="${b.img.h}" alt="${esc(b.img.alt)}" loading="lazy"><figcaption><span class="cap">${esc(b.caption)}</span>${b.credit ? `<span class="credit">${esc(b.credit)}</span>` : ''}</figcaption></figure>`;
    }
    if (b.t === 'slot') {
      return `<figure class="slot">
        <div class="slot-box">
          <span class="empty-ico">${icon('i-image')}</span>
          <strong>Фото пока нет</strong>
          <p>${esc(b.note)}</p>
          <button class="btn btn-secondary btn-sm" type="button" data-action="slot-upload" data-ch="${esc(ch.id)}" data-i="${i}">${icon('i-upload')}<span>Загрузить фото</span></button>
        </div>
        <figcaption><span class="cap">${esc(b.caption)}</span></figcaption>
      </figure>`;
    }
    return '';
  }

  function chapterNextHTML(s, ch, chs) {
    const idx = chs.findIndex((c) => c.id === ch.id);
    const nextCh = chs[idx + 1];
    const open = s.topics.filter((tp) => tp.status === 'current' || tp.status === 'later');
    const openTopic = ch.openTopic ? s.topics.find((tp) => tp.id === ch.openTopic) : null;
    const showOpen = ch.open && (!openTopic || openTopic.status !== 'done');
    return `<footer class="chapter-next">
      ${nextCh ? `<a class="btn btn-secondary btn-wrap" href="#/s/${s.id}/chapter/${nextCh.id}"><span>Глава ${nextCh.n}. ${esc(nextCh.title)}</span>${icon('i-arrow-right')}</a>` : ''}
      <h3>Что дальше</h3>
      ${showOpen ? `<p>${esc(ch.open)}</p>` : ''}
      ${open.length ? `<p class="help">Незаконченные темы: ${open.map((tp) => `«${esc(tp.title)}»`).join(', ')}.</p>` : '<p class="help">Все отмеченные темы рассказаны. Агент предложит новые в следующем разговоре.</p>'}
      <a class="btn btn-primary btn-wrap" href="#/s/${s.id}/talk">${icon('i-mic')}<span>Продолжить разговор</span></a>
    </footer>`;
  }

  function chapterHTML(s, sub) {
    if (!s.chapters.length) {
      return `<div class="chapter-layout"><div class="empty-card">
        <span class="empty-ico">${icon('i-book')}</span>
        <h2>Глава появится после разговора</h2>
        <p class="help">Ответьте на несколько вопросов и нажмите «Завершить и собрать главу». Редактор сохранит ваши выражения и свяжет текст с людьми, местами и исходными записями.</p>
        <a class="btn btn-primary" href="#/s/${s.id}/talk">${icon('i-mic')}<span>Перейти к разговору</span></a>
      </div></div>`;
    }
    const chs = s.chapters.map((id) => Object.assign({ id }, S.chapters[id]));
    const ch = chs.find((c) => c.id === sub) || chs[0];
    const n = ch.sources.length;
    const toc = `<nav class="toc" aria-label="Главы истории"><ol class="toc-list">
      ${chs.map((c) => `<li><a class="toc-link" href="#/s/${s.id}/chapter/${c.id}"${c.id === ch.id ? ' aria-current="page"' : ''}><span class="toc-num">Глава ${c.n}</span><span class="toc-title">${esc(c.title)}</span><span class="toc-meta">${c.sources.length} ${plural(c.sources.length, 'ответ', 'ответа', 'ответов')}</span></a></li>`).join('')}
      <li><div class="toc-pending"><span>Глава ${chs.length + 1}</span><span>Появится после следующего разговора</span></div></li>
    </ol></nav>`;
    let fresh = '';
    if (S.chapters[ch.id].fresh) {
      S.chapters[ch.id].freshShown = true;
      fresh = `<p class="fresh" role="status">${icon('i-check')}<span>Глава собрана из сегодняшнего разговора. Проверьте текст — его можно поправить, а каждый абзац ведёт к исходной записи.</span></p>`;
    }
    return `<div class="chapter-layout">
      ${toc}
      <article class="chapter t-${s.type}" aria-labelledby="chTitle">
        <div class="chapter-inner">
          <header class="ch-head">
            <p class="eyebrow">Глава ${ch.n}</p>
            <h2 id="chTitle">${esc(ch.title)}</h2>
            <p class="help">Собрано из ${n} ${plural(n, 'ответа', 'ответов', 'ответов')} · ${s.relation === 'я' ? 'рассказываете вы' : `рассказывает ${esc(s.narrator)}`}</p>
            <div class="ch-tools">
              <button class="btn btn-secondary btn-sm" type="button" data-action="toggle-edit" aria-pressed="${S.edit}">${icon(S.edit ? 'i-check' : 'i-edit')}<span>${S.edit ? 'Готово' : 'Редактировать текст'}</span></button>
              <button class="btn btn-ghost btn-sm" type="button" data-action="chapter-sources" data-ch="${esc(ch.id)}">${icon('i-mic')}<span>Исходные записи · ${n}</span></button>
            </div>
            ${S.edit ? '<p class="help">Меняйте текст абзацев — цитаты и исходные записи остаются как были сказаны.</p>' : ''}
            ${fresh}
          </header>
          ${ch.blocks.map((b, i) => blockHTML(b, i, s, ch)).join('')}
          ${chapterNextHTML(s, ch, chs)}
        </div>
      </article>
    </div>`;
  }

  /* ---------- люди / места и события ---------- */
  function emptyArchive(s, title, text, ic) {
    return `<div class="empty-card"><span class="empty-ico">${icon(ic)}</span><h2>${esc(title)}</h2><p class="help">${esc(text)}</p><a class="btn btn-primary" href="#/s/${s.id}/talk">${icon('i-mic')}<span>Перейти к разговору</span></a></div>`;
  }
  function peopleGridHTML(s, people) {
    if (!people.length) return emptyArchive(s, 'Людей пока нет', 'Они появятся, когда вы назовёте кого-то в разговоре. Людей с одинаковыми именами архивист не объединяет сам — спросит.', 'i-users');
    const twin = people.find((p) => p.twin && S.people[p.twin]);
    const notice = twin ? `<div class="notice">${icon('i-info')}<p>В истории два разных человека по имени ${esc(twin.name.split(' ')[0])} — <button class="link-btn" type="button" data-action="person" data-id="${esc(twin.id)}">${esc(twin.name)}</button> и <button class="link-btn" type="button" data-action="person" data-id="${esc(twin.twin)}">${esc(S.people[twin.twin].name)}</button>. Они хранятся отдельно, пока вы не решите иначе.</p></div>` : '';
    const sorted = people.slice().sort((a, b) => Number(!!b.narrator) - Number(!!a.narrator));
    const cards = sorted.map((p) => {
      const n = mentions('p', p.id).length;
      const badges = [p.narrator ? '<span class="pill">Рассказывает</span>' : `<span class="pill">${n} ${plural(n, 'упоминание', 'упоминания', 'упоминаний')}</span>`];
      if (S.fresh.has(p.id)) badges.push('<span class="pill pill-new">Новое</span>');
      if (p.twin && S.people[p.twin]) badges.push('<span class="pill">Есть тёзка</span>');
      return `<li><button class="pcard" type="button" data-action="person" data-id="${esc(p.id)}"><span class="avatar avatar-md t-${s.type}" aria-hidden="true">${esc(initials(p))}</span><span class="pcard-body"><span class="pcard-name">${esc(p.name)}</span><span class="pcard-role">${esc(p.role)}</span><span class="pcard-foot">${badges.join('')}</span></span></button></li>`;
    }).join('');
    return `${notice}<ul class="card-grid" style="list-style:none">${cards}</ul>`;
  }
  function placesGridHTML(s, places) {
    if (!places.length) return emptyArchive(s, 'Мест пока нет', 'Они появятся, когда в рассказе прозвучат город, улица или дом.', 'i-pin');
    return `<ul class="card-grid" style="list-style:none">${places.map((pl) => {
      const n = mentions('l', pl.id).length;
      const media = pl.photo
        ? `<img class="od-media od-media-cover" style="--od-ratio:3/2" src="${esc(pl.photo.src)}" width="${pl.photo.w}" height="${pl.photo.h}" alt="" loading="lazy">`
        : `<span class="plcard-ph">${icon('i-pin', 'ico-lg')}</span>`;
      return `<li><button class="plcard t-${s.type}" type="button" data-action="place" data-id="${esc(pl.id)}">${media}<span class="plcard-body"><span class="pcard-name">${esc(pl.name)}</span><span class="pcard-role">${esc(pl.role)}</span><span class="pcard-foot"><span class="pill">${n} ${plural(n, 'упоминание', 'упоминания', 'упоминаний')}</span>${S.fresh.has(pl.id) ? '<span class="pill pill-new">Новое</span>' : ''}</span></span></button></li>`;
    }).join('')}</ul>`;
  }
  function tlItemHTML(s, e) {
    const pl = e.place && S.places[e.place];
    const who = arr(e.people).filter((id) => S.people[id]).map((id) => whoBtn(s, id)).join('');
    const approx = e.approx && e.sort;
    return `<li class="tl-item${approx ? ' is-approx' : ''}">
      <div class="tl-date"><span class="tl-when od-nowrap">${esc(approxDate(e))}</span>${approx ? '<span class="approx">примерно</span>' : ''}${e.dateNote ? `<span class="help">${esc(e.dateNote)}</span>` : ''}${S.fresh.has(e.id) ? '<span class="pill pill-new">Новое</span>' : ''}</div>
      <h4 class="tl-title">${esc(e.title)}</h4>
      ${pl || who ? `<div class="tl-meta">${pl ? placeBtn(s, e.place) : ''}${who}</div>` : ''}
      ${arr(e.src).length ? `<div class="od-cluster">${e.src.map((id) => srcChip(id)).join('')}</div>` : ''}
    </li>`;
  }
  function timelineHTML(s, evs) {
    if (!evs.length) return emptyArchive(s, 'Событий пока нет', 'Агент добавит их, когда в рассказе появятся даты — даже приблизительные, вроде «когда выкопали картошку».', 'i-calendar');
    const groups = [];
    evs.forEach((e) => {
      const y = e.sort ? String(Math.floor(e.sort)) : 'Без точной даты';
      let g = groups.find((x) => x.y === y);
      if (!g) { g = { y, items: [] }; groups.push(g); }
      g.items.push(e);
    });
    return `<ol class="timeline">${groups.map((g) => `<li class="tl-year"><h3>${esc(g.y)}</h3><ol class="tl-items">${g.items.map((e) => tlItemHTML(s, e)).join('')}</ol></li>`).join('')}</ol>`;
  }
  function archiveHTML(s, sub) {
    const T = typeOf(s);
    const people = storyPeople(s.id);
    const places = storyPlaces(s.id);
    const evs = storyEvents(s.id);
    const vPeople = ['people', 'Люди', people.length];
    const vPlaces = ['places', 'Места', places.length];
    const views = T.primary === 'places' ? [vPlaces, vPeople] : [vPeople, vPlaces];
    views.push(['timeline', 'Хронология', evs.length]);
    const view = views.some((v) => v[0] === sub) ? sub : views[0][0];
    const nav = `<nav class="od-cluster" aria-label="Что показать">${views.map(([v, l, n]) => `<a class="chip" href="#/s/${s.id}/archive/${v}"${v === view ? ' aria-current="page"' : ''}><span>${l}</span><span class="n">${n}</span></a>`).join('')}</nav>`;
    let body;
    if (view === 'people') body = peopleGridHTML(s, people);
    else if (view === 'places') body = placesGridHTML(s, places);
    else body = timelineHTML(s, evs);
    return `<div class="archive">${nav}${body}</div>`;
  }

  /* ---------- панели: человек, место, исходный ответ ---------- */
  function excerpt(text, ent) {
    const stems = [].concat(ent.stem || ent.name.split(/\s+/).filter((w) => /^[А-ЯЁ]/.test(w)).slice(0, 1));
    const sentences = text.match(/[^.!?…]+[.!?…»]*/g) || [text];
    const hit = sentences.find((sen) => stems.some((st) => sen.toLowerCase().includes(String(st).toLowerCase())));
    return (hit || text).trim();
  }
  function mentionItem(x, ent) {
    return `<li class="sec-item">
      <span class="meta">Сессия ${x.session} · ${esc(x.date)} · ответ ${x.n}</span>
      <p class="od-clamp-3">${esc(ent ? excerpt(x.text, ent) : x.text)}</p>
      <div class="od-cluster">${x.typed ? '' : voiceBtn(`m-${x.id}`, x.dur, 'Слушать')}<button class="btn btn-ghost btn-xs" type="button" data-action="source" data-src="${esc(x.id)}">Открыть ответ</button></div>
    </li>`;
  }
  function eventsList(evs) {
    return evs.length
      ? `<ul class="sec-list">${evs.map((e) => `<li class="sec-item"><span class="meta">${esc(approxDate(e))}${e.approx && e.sort ? ' · примерно' : ''}</span><p><strong>${esc(e.title)}</strong></p></li>`).join('')}</ul>`
      : '<p class="help">Событий пока нет.</p>';
  }
  function personHTML(id, editIdx) {
    const p = S.people[id];
    const s = getStory(p.story);
    const srcs = mentions('p', id);
    const evs = storyEvents(s.id).filter((e) => arr(e.people).includes(id));
    const twin = p.twin && S.people[p.twin];
    const links = arr(p.links).map((l, i) => {
      const to = S.people[l.to];
      if (editIdx === i) {
        return `<li class="link-row">
          <label class="field-label" for="linkEdit">Связь с: ${esc(to ? to.name : '')}</label>
          <input class="input" id="linkEdit" type="text" value="${esc(l.label)}">
          <div class="od-cluster">
            <button class="btn btn-primary btn-sm" type="button" data-action="save-link" data-id="${esc(id)}" data-i="${i}">${icon('i-check')}<span>Сохранить</span></button>
            <button class="btn btn-ghost btn-sm" type="button" data-action="person" data-id="${esc(id)}">Отмена</button>
          </div>
        </li>`;
      }
      const basis = l.edited ? 'Исправлено вами' : (l.src && S.sources[l.src] ? `Основание: ${srcLabel(l.src).toLowerCase()}` : 'Основание: ваше уточнение');
      return `<li class="link-row">
        <div class="od-row" style="--od-gap:8px">
          <span class="od-field od-fill"><span class="link-label">${esc(l.label)}</span><span class="help">${esc(basis)}</span></span>
          ${l.src && S.sources[l.src] ? `<button class="icon-btn" type="button" data-action="source" data-src="${esc(l.src)}" aria-label="Открыть источник: ${esc(srcLabel(l.src))}">${icon('i-mic')}</button>` : ''}
          <button class="btn btn-ghost btn-xs" type="button" data-action="edit-link" data-id="${esc(id)}" data-i="${i}">Исправить</button>
        </div>
      </li>`;
    }).join('');
    return `
      <div class="ent-head"><span class="avatar avatar-lg t-${s.type}" aria-hidden="true">${esc(initials(p))}</span><div class="od-field" style="--od-gap:4px"><h3>${esc(p.name)}</h3><p>${esc(p.role)}</p></div></div>
      ${p.full && p.full !== p.name ? `<p class="help">Полное имя: ${esc(p.full)}</p>` : ''}
      ${arr(p.aka).length ? `<div class="od-cluster"><span class="help">Также называют:</span>${p.aka.map((a) => `<span class="pill">${esc(a)}</span>`).join('')}</div>` : ''}
      ${p.note ? `<p>${esc(p.note)}</p>` : ''}
      ${twin ? `<div class="notice">${icon('i-info')}<p>В истории есть ещё один человек с этим именем — <button class="link-btn" type="button" data-action="person" data-id="${esc(p.twin)}">${esc(twin.name)}</button>. Они хранятся отдельно: так подтверждено в разговоре.</p></div>` : ''}
      <section><h4>Связи</h4>${links ? `<ul style="list-style:none">${links}</ul>` : '<p class="help">Связи появятся, когда о человеке расскажут подробнее.</p>'}</section>
      <section><h4>События · ${evs.length}</h4>${eventsList(evs)}</section>
      <section><h4>${p.narrator ? 'Все ответы этой истории' : 'Упоминания'} · ${srcs.length}</h4>${srcs.length ? `<ul class="sec-list">${srcs.map((x) => mentionItem(x, p.narrator ? null : p)).join('')}</ul>` : '<p class="help">Упоминаний пока нет.</p>'}</section>`;
  }
  function placeHTML(id) {
    const pl = S.places[id];
    const s = getStory(pl.story);
    const srcs = mentions('l', id);
    const evs = storyEvents(s.id).filter((e) => e.place === id);
    return `
      ${pl.photo ? `<figure class="sheet-photo" style="margin:0"><img class="od-media" src="${esc(pl.photo.src)}" width="${pl.photo.w}" height="${pl.photo.h}" alt="${esc(pl.photo.alt)}"><figcaption class="credit" style="margin-top:8px">${esc(pl.photo.credit)}</figcaption></figure>` : ''}
      <div class="ent-head">${pl.photo ? '' : `<span class="avatar avatar-lg avatar-place t-${s.type}" aria-hidden="true">${icon('i-pin', 'ico-lg')}</span>`}<div class="od-field" style="--od-gap:4px"><h3>${esc(pl.name)}</h3><p>${esc(pl.role)}</p></div></div>
      ${pl.note ? `<p>${esc(pl.note)}</p>` : ''}
      <section><h4>События · ${evs.length}</h4>${eventsList(evs)}</section>
      <section><h4>Упоминания · ${srcs.length}</h4>${srcs.length ? `<ul class="sec-list">${srcs.map((x) => mentionItem(x, pl)).join('')}</ul>` : '<p class="help">Упоминаний пока нет.</p>'}</section>`;
  }
  function sourceHTML(id, frag) {
    const x = S.sources[id];
    const s = getStory(x.story);
    let text = esc(x.text);
    if (frag) {
      const f = esc(frag);
      const i = text.indexOf(f);
      if (i >= 0) text = `${text.slice(0, i)}<mark>${f}</mark>${text.slice(i + f.length)}`;
    }
    const ppl = arr(x.people).filter((pid) => S.people[pid]);
    const pls = arr(x.places).filter((pid) => S.places[pid]);
    const inCh = s.chapters.filter((cid) => S.chapters[cid].sources.includes(id));
    return `
      <p class="eyebrow">Сессия ${x.session} · ${esc(x.date)} · ответ ${x.n}</p>
      <div class="src-q"><span class="label">Вопрос агента</span><p>${esc(x.q)}</p></div>
      ${x.typed ? '<p class="help">Ответ написан текстом — записи голоса нет.</p>' : `<div>${voiceBtn(`s-${id}`, x.dur, 'Оригинальная запись')}</div>`}
      ${x.photo ? `<figure style="margin:0"><img class="od-media" style="border-radius:12px" src="${esc(x.photo.src)}" width="${x.photo.w}" height="${x.photo.h}" alt="Фото, приложенное к ответу"></figure>` : ''}
      <div class="src-text"><span class="label">Расшифровка${x.edited ? ' · исправлена вами' : ''}</span><p class="read">${text}</p></div>
      ${x.correction ? `<p class="note">${icon('i-info', 'ico-sm')}<span>${esc(x.correction)}</span></p>` : ''}
      ${ppl.length || pls.length ? `<section><h4>Кто и что упоминается</h4><div class="od-cluster">${ppl.map((pid) => whoBtn(s, pid)).join('')}${pls.map((pid) => placeBtn(s, pid)).join('')}</div></section>` : ''}
      ${inCh.length ? `<section><h4>Где используется</h4><div class="od-cluster">${inCh.map((cid) => `<a class="btn btn-secondary btn-sm btn-wrap" href="#/s/${s.id}/chapter/${cid}">${icon('i-book')}<span>Глава ${S.chapters[cid].n}. ${esc(S.chapters[cid].title)}</span></a>`).join('')}</div></section>` : ''}`;
  }

  function rememberFocus() {
    const a = document.activeElement;
    if (a && a !== document.body && !a.closest('dialog')) S.lastFocus = a;
  }
  function openSheet(title, html) {
    closePopover();
    const d = $('#sheet');
    $('#sheetTitle').textContent = title;
    $('#sheetBody').innerHTML = html;
    $('#sheetBody').scrollTop = 0;
    if (!d.open) { rememberFocus(); d.showModal(); }
    moveToasts();
    $('#sheetTitle').focus();
  }

  /* ---------- поповер упоминания ---------- */
  let popAnchor = null;
  function closePopover(restore) {
    const pop = $('#popover');
    if (pop.hidden) return;
    pop.hidden = true;
    pop.innerHTML = '';
    if (popAnchor) {
      popAnchor.setAttribute('aria-expanded', 'false');
      if (restore && document.contains(popAnchor)) popAnchor.focus();
    }
    popAnchor = null;
  }
  function openPopover(btn) {
    if (popAnchor === btn) { closePopover(true); return; }
    closePopover();
    const k = btn.dataset.kind;
    const id = btn.dataset.id;
    const e = k === 'p' ? S.people[id] : S.places[id];
    if (!e) return;
    const s = getStory(e.story);
    const n = mentions(k, id).length;
    const pop = $('#popover');
    pop.className = `popover t-${s.type}`;
    pop.innerHTML = `
      <div class="od-row" style="--od-gap:12px">
        ${k === 'p' ? `<span class="avatar t-${s.type}" aria-hidden="true">${esc(initials(e))}</span>` : `<span class="avatar avatar-place t-${s.type}" aria-hidden="true">${icon('i-pin', 'ico-sm')}</span>`}
        <div class="od-field od-fill"><span class="pop-name" id="popName">${esc(e.name)}</span><span class="help">${esc(e.role)}</span></div>
        <button class="icon-btn" type="button" data-action="close-pop" aria-label="Закрыть">${icon('i-x')}</button>
      </div>
      <p class="help">${k === 'p' && e.narrator ? 'Рассказывает эту историю' : `Упоминается в ${n} ${plural(n, 'ответе', 'ответах', 'ответах')}`}</p>
      <button class="btn btn-secondary btn-sm btn-block" type="button" data-action="${k === 'p' ? 'person' : 'place'}" data-id="${esc(id)}"><span>Открыть карточку</span>${icon('i-arrow-right', 'ico-sm')}</button>`;
    pop.hidden = false;
    const mobile = window.innerWidth < 768;
    pop.classList.toggle('as-sheet', mobile);
    if (mobile) {
      pop.style.left = '';
      pop.style.top = '';
    } else {
      const r = btn.getBoundingClientRect();
      const w = pop.offsetWidth;
      const h = pop.offsetHeight;
      const left = Math.min(Math.max(16, r.left), window.innerWidth - w - 16);
      let top = r.bottom + 8;
      if (top + h > window.innerHeight - 16) top = Math.max(16, r.top - h - 8);
      pop.style.left = `${left}px`;
      pop.style.top = `${top}px`;
    }
    btn.setAttribute('aria-expanded', 'true');
    popAnchor = btn;
    const go = $(`[data-action="${k === 'p' ? 'person' : 'place'}"]`, pop);
    if (go) go.focus({ preventScroll: true });
  }

  /* ---------- имитация воспроизведения записи ---------- */
  const V = { btn: null, raf: 0, start: 0, total: 0 };
  function stopVoice() {
    cancelAnimationFrame(V.raf);
    const b = V.btn;
    if (b) {
      b.setAttribute('aria-pressed', 'false');
      const pp = $('.pp', b); if (pp) pp.innerHTML = icon('i-play', 'ico-sm');
      const bar = $('.voice-track i', b); if (bar) bar.style.transform = 'scaleX(0)';
      const d = $('.v-dur', b); if (d) d.textContent = b.dataset.dur;
    }
    V.btn = null;
  }
  function toggleVoice(btn) {
    if (V.btn === btn) { stopVoice(); return; }
    stopVoice();
    stopSpeak();
    V.btn = btn;
    V.total = Math.max(1, parseDur(btn.dataset.dur));
    V.start = performance.now();
    btn.setAttribute('aria-pressed', 'true');
    $('.pp', btn).innerHTML = icon('i-pause', 'ico-sm');
    const bar = $('.voice-track i', btn);
    const d = $('.v-dur', btn);
    const loop = (now) => {
      const p = Math.min(1, (now - V.start) / 1000 / V.total);
      if (bar) bar.style.transform = `scaleX(${p.toFixed(3)})`;
      if (d) d.textContent = `${fmtTime(p * V.total)} / ${btn.dataset.dur}`;
      if (p >= 1) { stopVoice(); return; }
      V.raf = requestAnimationFrame(loop);
    };
    V.raf = requestAnimationFrame(loop);
  }

  /* ---------- озвучка вопроса ---------- */
  function setSpeakBtn(on) {
    const b = $('[data-action="speak"]');
    if (!b) return;
    b.setAttribute('aria-pressed', String(on));
    $('span', b).textContent = on ? 'Остановить озвучку' : 'Прослушать вопрос';
    $('use', b).setAttribute('href', on ? '#i-stop' : '#i-volume');
  }
  function stopSpeak() {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    setSpeakBtn(false);
  }
  function speak() {
    const synth = window.speechSynthesis;
    if (!synth || typeof window.SpeechSynthesisUtterance === 'undefined') { toast('В этом браузере нет озвучки — вопрос можно прочитать'); return; }
    if (synth.speaking) { stopSpeak(); return; }
    const q = $('#qText');
    if (!q) return;
    stopVoice();
    const u = new window.SpeechSynthesisUtterance(q.textContent);
    u.lang = 'ru-RU';
    u.rate = 0.95;
    const voices = synth.getVoices();
    const ru = voices.find((v) => /^ru/i.test(v.lang));
    if (ru) u.voice = ru;
    else if (voices.length) toast('Русского голоса в системе нет — читаю голосом по умолчанию');
    u.onend = () => setSpeakBtn(false);
    u.onerror = () => setSpeakBtn(false);
    setSpeakBtn(true);
    synth.speak(u);
  }

  /* ---------- запись и обработка ответа ---------- */
  function clearRecTimers() {
    clearInterval(S.timers.rec);
    clearInterval(S.timers.levels);
    clearTimeout(S.timers.proc);
  }
  function startRec(s) {
    stopSpeak();
    stopVoice();
    const t = s.talk;
    t.rec = 'recording';
    t.recStart = performance.now();
    rerender('[data-action="rec-stop"]');
    announce('Идёт запись. Нажмите «Остановить запись», когда закончите.');
    S.timers.rec = setInterval(() => {
      const el = $('#recTimer');
      if (el) el.textContent = fmtTime((performance.now() - t.recStart) / 1000);
    }, 250);
    const tickLevels = () => $$('#levels i').forEach((b) => { b.style.transform = `scaleY(${(0.15 + Math.random() * 0.85).toFixed(2)})`; });
    tickLevels();
    S.timers.levels = setInterval(tickLevels, reduceMotion.matches ? 700 : 130);
  }
  function procTick(s) {
    const t = s.talk;
    if (t.rec !== 'processing') return;
    t.step += 1;
    const q = currentQuestion(s);
    if (t.step === 2 && q && q.failOnce && !t.failed && !t.photoQ) {
      t.failed = true;
      t.rec = 'error';
      rerender('[data-action="rec-retry"]');
      announce('Не получилось расшифровать запись. Запись сохранена.');
      return;
    }
    if (t.step >= STEPS.length) {
      t.rec = 'review';
      t.draft = q ? answerFor(s, q).text : '';
      rerender('#draft');
      announce('Расшифровка готова. Проверьте текст и сохраните ответ.');
      return;
    }
    rerender('#recorder');
    S.timers.proc = setTimeout(() => procTick(s), 700);
  }
  function stopRec(s) {
    const t = s.talk;
    clearRecTimers();
    t.dur = Math.max(1, (performance.now() - t.recStart) / 1000);
    t.rec = 'processing';
    t.step = 1;
    rerender('#recorder');
    announce('Запись сохранена. Расшифровываем.');
    S.timers.proc = setTimeout(() => procTick(s), 800);
  }
  function retryRec(s) {
    const t = s.talk;
    t.rec = 'processing';
    t.step = 1;
    rerender('#recorder');
    S.timers.proc = setTimeout(() => procTick(s), 800);
  }

  function saveAnswer(s, typedText) {
    const t = s.talk;
    const q = currentQuestion(s);
    if (!q) return;
    const typed = typeof typedText === 'string';
    const ans = typed ? { text: typedText } : (answerFor(s, q) || { text: '' });
    const draft = $('#draft');
    const text = typed ? typedText : ((draft && draft.value.trim()) || ans.text);
    const added = { people: [], places: [], events: [] };
    const srcPeople = new Set();
    const srcPlaces = new Set();
    if (!typed) {
      const add = ans.add || {};
      arr(add.people).forEach((p) => {
        const id = rid(s, p.id);
        if (!S.people[id]) {
          S.people[id] = { story: s.id, name: p.name, full: p.name, role: p.role, stem: p.stem, aka: [], note: '', links: [] };
          S.fresh.add(id);
          added.people.push(id);
        }
        srcPeople.add(id);
      });
      arr(add.places).forEach((p) => {
        const id = rid(s, p.id);
        if (!S.places[id]) {
          S.places[id] = { story: s.id, name: p.name, role: p.role, stem: p.stem, note: '' };
          S.fresh.add(id);
          added.places.push(id);
        }
        srcPlaces.add(id);
      });
      const refs = ans.refs || {};
      arr(refs.people).forEach((id) => { const r = rid(s, id); if (S.people[r]) srcPeople.add(r); });
      arr(refs.places).forEach((id) => { const r = rid(s, id); if (S.places[r]) srcPlaces.add(r); });
    }
    const n = storySources(s.id).filter((x) => x.session === t.session).length + 1;
    const srcId = `${s.id}-${t.session}-${n}`;
    S.sources[srcId] = {
      story: s.id, session: t.session, n, date: 'сегодня', q: q.text,
      dur: typed ? '0:00' : fmtTime(t.dur), text, typed,
      edited: !typed && text !== ans.text,
      people: Array.from(srcPeople).filter((id) => !S.people[id].narrator),
      places: Array.from(srcPlaces),
      photo: t.photoQ ? t.photo : null
    };
    if (!typed) {
      arr(ans.add && ans.add.events).forEach((e) => {
        const id = rid(s, e.id);
        if (S.events.some((x) => x.id === id)) return;
        S.events.push(Object.assign({}, e, {
          id, story: s.id,
          people: arr(e.people).map((p) => rid(s, p)),
          place: e.place ? rid(s, e.place) : null,
          src: [srcId]
        }));
        S.fresh.add(id);
        added.events.push(id);
      });
      arr(ans.clarify).forEach((c) => { if (!s.clarify.some((x) => x.id === c.id)) s.clarify.push(Object.assign(clone(c), { src: srcId })); });
    }
    t.turns.push({ q: q.text, src: srcId, topicTitle: t.photoQ ? 'Фото' : (q.topicTitle || '') });
    if (t.photoQ) { t.photoQ = null; t.photo = null; }
    else {
      if (q.topic) setTopic(s, q.topic, 'done', q.topicTitle);
      t.pos += 1;
      t.failed = false;
    }
    t.rec = 'idle';
    t.draft = '';
    s.updated = 'только что';
    s.noteStale = true;
    activateNextTopic(s);
    S.qEnter = true;
    rerender('#qText', true);
    const parts = [];
    if (added.people.length) parts.push(`${added.people.length} ${plural(added.people.length, 'человек', 'человека', 'человек')}`);
    if (added.places.length) parts.push(`${added.places.length} ${plural(added.places.length, 'место', 'места', 'мест')}`);
    if (added.events.length) parts.push(`${added.events.length} ${plural(added.events.length, 'событие', 'события', 'событий')}`);
    toast(parts.length ? `Ответ сохранён. Новое: ${parts.join(', ')}` : 'Ответ сохранён');
  }

  function skipQuestion(s, declined) {
    const t = s.talk;
    const q = currentQuestion(s);
    if (!q) return;
    stopSpeak();
    t.turns.push({ q: q.text, skipped: !declined, declined });
    if (t.photoQ) { t.photoQ = null; t.photo = null; }
    else {
      if (q.topic) setTopic(s, q.topic, declined ? 'declined' : 'later', q.topicTitle);
      t.pos += 1;
      t.failed = false;
    }
    t.rec = 'idle';
    activateNextTopic(s);
    S.qEnter = true;
    rerender('#qText', true);
    toast(declined ? 'Хорошо, к этой теме больше не вернусь' : 'Вопрос отложен — тема осталась в списке');
  }

  function resolveClarify(s, id, v) {
    const c = s.clarify.find((x) => x.id === id);
    if (!c) return;
    c.resolved = v;
    const ap = c.apply && c.apply[v];
    if (ap) {
      if (ap.role) { const pid = rid(s, ap.role[0]); if (S.people[pid]) S.people[pid].role = ap.role[1]; }
      if (ap.links) {
        ap.links.forEach(([a, b, label]) => {
          const pa = rid(s, a);
          const pb = rid(s, b);
          if (S.people[pa] && S.people[pb]) S.people[pa].links.push({ to: pb, label, src: c.src });
        });
      }
      if (ap.note) { const pid = rid(s, ap.note[0]); if (S.places[pid]) S.places[pid].note = ap.note[1]; }
    }
    rerender('#mc');
    toast(v === 'yes' ? c.yesMsg : c.noMsg);
  }

  /* ---------- сборка главы ---------- */
  function autoLink(x) {
    const text = x.text;
    const found = [];
    const tryAdd = (kind, id, ent) => {
      const stems = [].concat(ent.stem || ent.name.split(/\s+/).filter((w) => /^[А-ЯЁ]/.test(w)).slice(0, 1));
      for (let k = 0; k < stems.length; k += 1) {
        const re = new RegExp(`(^|[^А-Яа-яЁё])(${escRe(stems[k])}[а-яё]*)`);
        const m = re.exec(text);
        if (m) {
          const start = m.index + m[1].length;
          const end = start + m[2].length;
          if (!found.some((f) => start < f.end && end > f.start)) found.push({ start, end, kind, id });
          return;
        }
      }
    };
    arr(x.people).forEach((id) => { if (S.people[id]) tryAdd('p', id, S.people[id]); });
    arr(x.places).forEach((id) => { if (S.places[id]) tryAdd('l', id, S.places[id]); });
    found.sort((a, b) => a.start - b.start);
    let out = '';
    let pos = 0;
    found.forEach((f) => { out += `${text.slice(pos, f.start)}[[${f.kind}:${f.id}|${text.slice(f.start, f.end)}]]`; pos = f.end; });
    return out + text.slice(pos);
  }
  function assemble(s) {
    const t = s.talk;
    const answered = t.turns.filter((x) => x.src);
    const srcIds = answered.map((x) => x.src);
    const k = s.chapters.length + 1;
    const id = `${s.id}-ch${k}`;
    const titled = answered.find((x) => x.topicTitle && x.topicTitle !== 'Фото');
    const blocks = [];
    srcIds.forEach((sid) => {
      const x = S.sources[sid];
      if (x.photo) blocks.push({ t: 'fig', img: { src: x.photo.src, w: x.photo.w, h: x.photo.h, alt: 'Фото, приложенное к ответу' }, caption: 'Фото из разговора.', credit: 'Загружено вами' });
      blocks.push({ t: 'p', src: sid, text: autoLink(x) });
    });
    const qid = srcIds.find((sid) => !S.sources[sid].typed);
    if (qid) {
      const qx = S.sources[qid];
      const first = ((qx.text.match(/[^.!?…]+[.!?…]/) || [qx.text])[0]).trim().replace(/\.$/, '');
      blocks.splice(Math.min(1, blocks.length), 0, { t: 'quote', src: qid, by: s.narratorId, text: first, dur: fmtTime(Math.min(parseDur(qx.dur), 12)) });
    }
    S.chapters[id] = { story: s.id, n: k, title: titled ? titled.topicTitle : `Глава ${k}`, sources: srcIds, blocks, fresh: true };
    s.chapters.push(id);
    s.sessions.push({ n: t.session, date: 'сегодня', answers: srcIds.length });
    const pos = t.pos;
    s.talk = newTalk(t.session + 1);
    s.talk.pos = pos;
    s.updated = 'только что';
    return id;
  }
  function openFinish(s) {
    const n = s.talk.turns.filter((x) => x.src).length;
    $('#confirmInner').innerHTML = `
      <header class="modal-head">
        <div class="od-stack" style="--od-gap:4px"><p class="eyebrow">Сессия ${s.talk.session}</p><h2 id="confirmTitle">Собрать главу?</h2></div>
        <button class="icon-btn" type="button" data-action="close-dialog" aria-label="Закрыть">${icon('i-x')}</button>
      </header>
      <div class="modal-body" id="confirmBody">
        <p>Из ${n} ${plural(n, 'ответа', 'ответов', 'ответов')} этой сессии получится новая глава. Редактор сохранит ваши выражения и свяжет текст с людьми, местами и записями.</p>
        <p class="help" style="margin-top:12px">Разговор можно продолжить в любой момент — агент помнит незаконченные темы.</p>
      </div>
      <footer class="modal-foot">
        <button class="btn btn-secondary" type="button" data-action="close-dialog">Ещё поговорить</button>
        <button class="btn btn-primary" type="button" data-action="assemble">${icon('i-book')}<span>Собрать главу</span></button>
      </footer>`;
    rememberFocus();
    $('#confirmDialog').showModal();
    moveToasts();
  }
  function runAssemble(s) {
    const steps = ['Собираем текст из ответов', 'Связываем людей, места и события', 'Добавляем ссылки на исходные записи'];
    let k = 0;
    $('#confirmInner .modal-foot').innerHTML = `<button class="btn btn-primary" type="button" disabled aria-busy="true"><span>Собираем главу…</span></button>`;
    const draw = () => { $('#confirmBody').innerHTML = stepsHTML(steps, k, 'Сборка главы'); };
    draw();
    const tick = () => {
      k += 1;
      if (k >= steps.length) {
        const id = assemble(s);
        $('#confirmDialog').close();
        location.hash = `#/s/${s.id}/chapter/${id}`;
        toast('Глава собрана');
        return;
      }
      draw();
      S.timers.asm = setTimeout(tick, 650);
    };
    S.timers.asm = setTimeout(tick, 650);
  }

  /* ---------- правка абзацев и фото в главе ---------- */
  function relink(oldText, newText) {
    const toks = [];
    String(oldText).replace(TOK, (m, k, id, label) => { toks.push({ k, id, label }); return m; });
    let out = newText;
    const ph = [];
    toks.forEach((tk) => {
      const i = out.indexOf(tk.label);
      if (i < 0) return;
      ph.push(`[[${tk.k}:${tk.id}|${tk.label}]]`);
      out = `${out.slice(0, i)}\u0001${ph.length - 1}\u0002${out.slice(i + tk.label.length)}`;
    });
    return out.replace(/\u0001(\d+)\u0002/g, (m, n) => ph[Number(n)]);
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      if (!file || !/^image\//.test(file.type)) { reject(new Error('not an image')); return; }
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => resolve({ src: url, w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => reject(new Error('broken image'));
      img.src = url;
    });
  }

  /* ---------- создание истории ---------- */
  const pickPhotoBtn = () => `<button class="btn btn-secondary btn-sm" type="button" data-action="pick-start-photo" aria-describedby="l-photo h-photo">${icon('i-upload')}<span>Выбрать фото</span></button>`;
  const selectedType = () => { const r = $('#typePicker input:checked'); return r ? r.value : 'family'; };
  function renderTypePicker(sel) {
    $('#typePicker').innerHTML = `<legend>О чём будет история?</legend>${Object.keys(D.types).map((k) => {
      const T = D.types[k];
      return `<label class="type-option t-${k}"><input type="radio" name="type" value="${k}"${k === sel ? ' checked' : ''}><span class="type-ico">${icon(T.icon)}</span><span class="type-name">${esc(T.label)}</span><span class="type-hint">${esc(T.hint)}</span><span class="check" aria-hidden="true">${icon('i-check', 'ico-sm')}</span></label>`;
    }).join('')}`;
  }
  function setStep(n) {
    C.step = n;
    $('#createStep').textContent = `Шаг ${n} из 2`;
    $('[data-step="1"]').hidden = n !== 1;
    $('[data-step="2"]').hidden = n !== 2;
    $('[data-action="create-back"]').hidden = n !== 2;
    $('#createNext').hidden = n !== 1;
    $('#createSubmit').hidden = n !== 2;
    if (n === 2) {
      const T = D.types[selectedType()];
      $('#createTitle').textContent = `Новая история · ${T.label}`;
      $('#f-about').placeholder = T.aboutPlaceholder;
    } else {
      $('#createTitle').textContent = 'Новая история';
    }
  }
  const RULES = {
    narrator: (v) => (v.trim().length >= 2 || /^я$/i.test(v.trim()) ? '' : 'Укажите, кто рассказывает: имя, обращение или «Я».'),
    about: (v) => (v.trim().length >= 3 ? '' : 'Опишите тему в паре слов — например, «Как мы переехали».')
  };
  function setErr(name, msg) {
    const input = $(`#f-${name}`);
    const err = $(`#err-${name}`);
    input.classList.toggle('is-invalid', !!msg);
    if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
    err.hidden = !msg;
    $('span', err).textContent = msg;
  }
  function validate(name) {
    const msg = RULES[name]($(`#f-${name}`).value);
    setErr(name, msg);
    return msg;
  }
  function openCreate(type) {
    closePopover();
    if ($('#drawer').open) $('#drawer').close();
    $('#createForm').reset();
    C.photo = null;
    $('#photoRow').innerHTML = pickPhotoBtn();
    setErr('narrator', '');
    setErr('about', '');
    $('#errSummary').hidden = true;
    const submit = $('#createSubmit');
    submit.disabled = false;
    submit.removeAttribute('aria-busy');
    $('span', submit).textContent = 'Начать разговор';
    renderTypePicker(D.types[type] ? type : 'family');
    setStep(D.types[type] ? 2 : 1);
    rememberFocus();
    $('#createDialog').showModal();
    moveToasts();
    const f = D.types[type] ? $('#f-narrator') : $('#typePicker input:checked');
    if (f) f.focus();
  }
  function createStory() {
    const type = selectedType();
    const narrator = $('#f-narrator').value.trim();
    const about = $('#f-about').value.trim();
    const relation = /^я$/i.test(narrator) ? 'я' : $('#f-relation').value;
    const id = `n${Date.now().toString(36)}`;
    const q0 = D.scripts[type][0];
    const s = {
      id, type,
      title: about.charAt(0).toUpperCase() + about.slice(1),
      narrator: relation === 'я' ? D.user.name : narrator,
      relation, narratorId: null,
      cover: C.photo ? { src: C.photo.src, w: C.photo.w, h: C.photo.h, alt: 'Фото, с которого начинается история' } : null,
      sessions: [], updated: 'только что', chapters: [], continueNote: '',
      topics: [{ id: q0.topic, title: q0.topicTitle, status: 'current' }],
      clarify: [], demo: false, talk: newTalk(1)
    };
    if (C.photo) {
      s.talk.photo = C.photo;
      s.talk.photoQ = { text: D.types[type].photoQuestion, why: 'Вы начали с фото — с него и начнём.' };
    }
    S.stories.unshift(s);
    return id;
  }

  /* ---------- тосты и объявления ---------- */
  function moveToasts() {
    const host = document.querySelector('dialog[open]') || document.body;
    const box = $('#toasts');
    if (box.parentElement !== host) host.appendChild(box);
  }
  function toast(msg) {
    moveToasts();
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `${icon('i-check', 'ico-sm')}<span>${esc(msg)}</span>`;
    $('#toasts').appendChild(el);
    setTimeout(() => { el.classList.add('is-out'); setTimeout(() => el.remove(), 220); }, 3200);
  }
  function announce(msg) {
    const el = $('#srLive');
    el.textContent = '';
    setTimeout(() => { el.textContent = msg; }, 40);
  }

  /* ---------- маршрутизация и отрисовка ---------- */
  function parseRoute() {
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    if (parts[0] === 's' && getStory(parts[1])) {
      return { view: ['talk', 'chapter', 'archive'].includes(parts[2]) ? parts[2] : 'talk', sid: parts[1], sub: parts[3] || null };
    }
    return { view: 'home' };
  }
  function render() {
    stopVoice();
    closePopover();
    const r = parseRoute();
    S.route = r;
    $('#main').innerHTML = r.view === 'home' ? homeHTML() : storyHTML(r);
    const active = r.view === 'home' ? 'home' : r.sid;
    $('#nav').innerHTML = navHTML(active);
    $('#drawerNav').innerHTML = navHTML(active);
    document.title = r.view === 'home' ? 'Помню — истории, рассказанные голосом' : `${getStory(r.sid).title} — Помню`;
    S.qEnter = false;
    if (window.speechSynthesis && window.speechSynthesis.speaking) setSpeakBtn(true);
  }
  function rerender(focusSel, reveal) {
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
    if (!focusSel) return;
    const el = $(focusSel);
    if (!el) return;
    el.focus({ preventScroll: true });
    if (reveal) el.scrollIntoView({ block: 'center', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
  }
  function navigate() {
    // незаконченная запись не теряется: при уходе со страницы она сразу попадает на проверку
    S.stories.forEach((s) => {
      const t = s.talk;
      if (t.rec === 'recording') t.dur = Math.max(1, (performance.now() - t.recStart) / 1000);
      if (t.rec === 'recording' || t.rec === 'processing') {
        const q = currentQuestion(s);
        t.rec = q ? 'review' : 'idle';
        t.draft = q ? answerFor(s, q).text : '';
      }
    });
    clearRecTimers();
    clearTimeout(S.timers.asm);
    stopSpeak();
    closePopover();
    Object.keys(S.chapters).forEach((id) => { if (S.chapters[id].freshShown) S.chapters[id].fresh = false; });
    S.edit = false;
    S.editing = null;
    render();
    window.scrollTo(0, S.scroll[location.hash || '#/'] || 0);
    if (!S.first) {
      const h = $('#main h1');
      if (h) h.focus({ preventScroll: true });
      const page = $('#main .page');
      if (page && !reduceMotion.matches) page.classList.add('is-entering');
    }
    S.first = false;
  }

  /* ---------- события ---------- */
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-skip]')) { e.preventDefault(); $('#main').focus(); return; }
    const dlgLink = e.target.closest('dialog a[href^="#/"]');
    if (dlgLink) { const d = dlgLink.closest('dialog'); if (d.open) d.close(); }
    if (!e.target.closest('#popover') && !e.target.closest('[data-action="mention"]')) closePopover();

    const el = e.target.closest('[data-action]');
    if (!el || el.disabled) return;
    const a = el.dataset.action;
    const s = S.route.sid ? getStory(S.route.sid) : null;
    const t = s ? s.talk : null;

    switch (a) {
      case 'create': openCreate(el.dataset.type); break;
      case 'open-drawer': rememberFocus(); $('#drawer').showModal(); break;
      case 'close-dialog': { const d = el.closest('dialog'); if (d) d.close(); break; }
      case 'filter': S.filter = el.dataset.type; rerender(`[data-action="filter"][data-type="${S.filter}"]`); break;

      case 'rec-start': if (s) startRec(s); break;
      case 'rec-stop': if (s) stopRec(s); break;
      case 'rec-cancel': if (s) { clearRecTimers(); t.rec = 'idle'; rerender('[data-action="rec-start"]'); toast('Запись отменена'); } break;
      case 'rec-retry': if (s) retryRec(s); break;
      case 'rec-again': if (s) { t.rec = 'idle'; t.draft = ''; rerender('[data-action="rec-start"]'); } break;
      case 'rec-type': if (s) { t.rec = 'typing'; rerender('#typed'); } break;
      case 'rec-idle': if (s) { t.rec = 'idle'; rerender('[data-action="rec-start"]'); } break;
      case 'save-answer': if (s) saveAnswer(s); break;
      case 'save-typed': {
        if (!s) break;
        const area = $('#typed');
        const v = area.value.trim();
        if (!v) {
          $('#typedErr').hidden = false;
          area.classList.add('is-invalid');
          area.setAttribute('aria-invalid', 'true');
          area.focus();
          break;
        }
        saveAnswer(s, v);
        break;
      }
      case 'skip': if (s) skipQuestion(s, false); break;
      case 'decline': if (s) skipQuestion(s, true); break;
      case 'attach': $('#photoInput').click(); break;
      case 'remove-photo': if (s) { t.photo = null; t.photoQ = null; rerender('#qText'); toast('Фото убрано'); } break;
      case 'speak': speak(); break;
      case 'play': toggleVoice(el); break;
      case 'finish': if (s) openFinish(s); break;
      case 'assemble': if (s) runAssemble(s); break;
      case 'clarify': if (s) resolveClarify(s, el.dataset.id, el.dataset.v); break;
      case 'jump-materials': {
        const m = $('#materials');
        if (m) { m.scrollIntoView({ block: 'start', behavior: reduceMotion.matches ? 'auto' : 'smooth' }); m.focus({ preventScroll: true }); }
        break;
      }

      case 'mention': openPopover(el); break;
      case 'close-pop': closePopover(true); break;
      case 'person': if (S.people[el.dataset.id]) openSheet('Карточка человека', personHTML(el.dataset.id)); break;
      case 'place': if (S.places[el.dataset.id]) openSheet('Место', placeHTML(el.dataset.id)); break;
      case 'source': if (S.sources[el.dataset.src]) openSheet('Исходный ответ', sourceHTML(el.dataset.src, el.dataset.frag)); break;
      case 'chapter-sources': {
        const ch = S.chapters[el.dataset.ch];
        openSheet(`Записи главы «${ch.title}»`, `<p class="help">Каждый абзац главы опирается на один из этих ответов. Записи хранятся без изменений.</p><ul class="sec-list">${ch.sources.map((id) => mentionItem(Object.assign({ id }, S.sources[id]), null)).join('')}</ul>`);
        break;
      }
      case 'edit-link': {
        $('#sheetBody').innerHTML = personHTML(el.dataset.id, Number(el.dataset.i));
        const inp = $('#linkEdit');
        if (inp) { inp.focus(); inp.select(); }
        break;
      }
      case 'save-link': {
        const p = S.people[el.dataset.id];
        const link = p && p.links[Number(el.dataset.i)];
        const v = $('#linkEdit').value.trim();
        if (link && v && v !== link.label) { link.label = v; link.edited = true; toast('Связь исправлена'); }
        $('#sheetBody').innerHTML = personHTML(el.dataset.id);
        const back = $(`#sheetBody [data-action="edit-link"][data-i="${el.dataset.i}"]`);
        if (back) back.focus();
        break;
      }

      case 'toggle-edit': S.edit = !S.edit; S.editing = null; rerender('[data-action="toggle-edit"]'); break;
      case 'edit-blk': S.editing = `${el.dataset.ch}:${el.dataset.i}`; rerender('#ed'); break;
      case 'cancel-blk': S.editing = null; rerender(`[data-action="edit-blk"][data-ch="${el.dataset.ch}"][data-i="${el.dataset.i}"]`); break;
      case 'save-blk': {
        const b = S.chapters[el.dataset.ch].blocks[Number(el.dataset.i)];
        const v = $('#ed').value.trim();
        if (!v) { toast('Абзац не может быть пустым — нажмите «Отмена», чтобы вернуть текст'); break; }
        if (v !== plain(b.text)) { b.text = relink(b.text, v); b.edited = true; toast('Абзац сохранён. Исходная запись не изменилась'); }
        S.editing = null;
        rerender(`[data-action="edit-blk"][data-ch="${el.dataset.ch}"][data-i="${el.dataset.i}"]`);
        break;
      }
      case 'slot-upload': S.slot = { ch: el.dataset.ch, i: Number(el.dataset.i) }; $('#slotInput').click(); break;

      case 'create-next': setStep(2); $('#f-narrator').focus(); break;
      case 'create-back': setStep(1); { const r = $('#typePicker input:checked'); if (r) r.focus(); } break;
      case 'pick-start-photo': $('#f-photo').click(); break;
      case 'clear-start-photo': C.photo = null; $('#photoRow').innerHTML = pickPhotoBtn(); $('[data-action="pick-start-photo"]').focus(); break;
      case 'focus-field': { const f = document.getElementById(el.dataset.field); if (f) f.focus(); break; }
      default: break;
    }
  });

  document.addEventListener('change', (e) => {
    const input = e.target;
    if (input.id === 'photoInput') {
      const s = S.route.sid ? getStory(S.route.sid) : null;
      const file = input.files && input.files[0];
      input.value = '';
      if (!s || !file) return;
      loadImage(file).then((ph) => {
        s.talk.photo = ph;
        s.talk.photoQ = { text: typeOf(s).photoQuestion, why: 'Фото помогает вспомнить детали: кто рядом, что было до и после снимка.' };
        s.talk.rec = 'idle';
        S.qEnter = true;
        rerender('#qText', true);
        toast('Фото прикреплено — агент спросит о нём');
      }).catch(() => toast('Не получилось открыть файл. Выберите изображение JPG или PNG.'));
    } else if (input.id === 'slotInput') {
      const file = input.files && input.files[0];
      input.value = '';
      const target = S.slot;
      S.slot = null;
      if (!file || !target) return;
      loadImage(file).then((ph) => {
        const ch = S.chapters[target.ch];
        const b = ch.blocks[target.i];
        ch.blocks[target.i] = { t: 'fig', img: { src: ph.src, w: ph.w, h: ph.h, alt: b.caption }, caption: b.caption, credit: 'Загружено вами' };
        rerender();
        toast('Фото добавлено в главу');
      }).catch(() => toast('Не получилось открыть файл. Выберите изображение JPG или PNG.'));
    } else if (input.id === 'f-photo') {
      const file = input.files && input.files[0];
      input.value = '';
      if (!file) return;
      loadImage(file).then((ph) => {
        C.photo = ph;
        $('#photoRow').innerHTML = `<img class="file-thumb" src="${esc(ph.src)}" width="${ph.w}" height="${ph.h}" alt="Выбранное фото"><button class="btn btn-ghost btn-sm" type="button" data-action="clear-start-photo">Убрать фото</button>`;
      }).catch(() => toast('Не получилось открыть файл. Выберите изображение JPG или PNG.'));
    }
  });

  ['narrator', 'about'].forEach((name) => {
    const f = $(`#f-${name}`);
    f.addEventListener('blur', () => { if (C.step === 2 && $('#createDialog').open) validate(name); });
    f.addEventListener('input', () => { if (f.classList.contains('is-invalid')) validate(name); });
  });
  document.addEventListener('input', (e) => {
    if (e.target.id === 'typed' && e.target.value.trim()) {
      e.target.classList.remove('is-invalid');
      e.target.removeAttribute('aria-invalid');
      const err = $('#typedErr');
      if (err) err.hidden = true;
    }
  });

  $('#createForm').addEventListener('submit', (e) => {
    e.preventDefault();
    if (C.step !== 2) { setStep(2); $('#f-narrator').focus(); return; }
    const labels = { narrator: 'Кто рассказывает', about: 'О чём хотите поговорить' };
    const errs = ['narrator', 'about'].map((n) => [n, validate(n)]).filter((x) => x[1]);
    const sum = $('#errSummary');
    if (errs.length) {
      $('#errList').innerHTML = errs.map(([n, m]) => `<li><button class="link-btn" type="button" data-action="focus-field" data-field="f-${n}">${labels[n]}</button> — ${esc(m)}</li>`).join('');
      sum.hidden = false;
      sum.focus();
      return;
    }
    sum.hidden = true;
    const btn = $('#createSubmit');
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    $('span', btn).textContent = 'Создаём историю…';
    setTimeout(() => {
      const id = createStory();
      $('#createDialog').close();
      location.hash = `#/s/${id}/talk`;
      toast('История создана — первый вопрос уже ждёт');
    }, 700);
  });

  $$('dialog').forEach((d) => {
    d.addEventListener('close', () => {
      if (d.id === 'confirmDialog') clearTimeout(S.timers.asm);
      if (d.id === 'sheet') stopVoice();
      moveToasts();
      const el = S.lastFocus;
      if (el && document.contains(el) && !el.closest('dialog')) el.focus({ preventScroll: true });
    });
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#popover').hidden) { e.preventDefault(); closePopover(true); }
  });
  window.addEventListener('scroll', () => {
    S.scroll[location.hash || '#/'] = window.scrollY;
    const pop = $('#popover');
    if (!pop.hidden && !pop.classList.contains('as-sheet')) closePopover();
  }, { passive: true });
  window.addEventListener('resize', () => closePopover());
  window.addEventListener('hashchange', navigate);
  if (window.speechSynthesis && typeof window.speechSynthesis.getVoices === 'function') window.speechSynthesis.getVoices();

  navigate();
})();
