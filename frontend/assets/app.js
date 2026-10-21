/* «Помню»: маршруты, голосовой разговор через API,
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
    stories: D.stories.map((s) => Object.assign(clone(s), { demo: !D.server, talk: Object.assign(newTalk(s.interview?.session || s.sessions.length + 1), {turns: clone(s.interview?.turns || []), photo: s.interview?.photo || null}) })),
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
    return s.interview?.question || null;
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
        <div class="continue-media">${cont.cover ? `<img src="${esc(cont.cover.src)}" width="${cont.cover.w}" height="${cont.cover.h}" alt="${esc(cont.cover.alt)}">` : `<div class="type-cover">${icon(typeOf(cont).icon)}</div>`}</div>
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
  const locked = (t) => !!t.pendingAnswer || (t.rec !== 'idle' && t.rec !== 'typing');

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
    const label = t.photo ? 'Фото к ответу' : (topic ? topic.title : (q.topicTitle || ''));
    const photo = t.photo ? `<figure class="q-photo"><img class="od-media" src="${esc(t.photo.src)}" width="${t.photo.w}" height="${t.photo.h}" alt="Фото, которое вы прикрепили к разговору"><figcaption><span>Прикреплённое фото</span><button class="link-btn" type="button" data-action="remove-photo"${locked(t) ? ' disabled' : ''}>Убрать</button></figcaption></figure>` : '';
    return `<section class="qcard${S.qEnter ? ' is-entering' : ''}" aria-labelledby="qText">
      <div class="q-meta">${agentDot}<span>Вопрос ${t.turns.length + 1}</span><span aria-hidden="true">·</span><span>${esc(label)}</span></div>
      <h2 class="q-text" id="qText" tabindex="-1">${esc(q.text)}</h2>
      ${q.why ? `<p class="q-why">${icon('i-info', 'ico-sm')}<span>Почему спрашиваю: ${esc(q.why)}</span></p>` : ''}
      ${photo}
      <div class="recorder" id="recorder" tabindex="-1">${recorderHTML(s)}</div>
    </section>`;
  }

  function doneHTML(s) {
    const any = s.talk.turns.some((x) => x.src);
    return `<section class="qcard" aria-labelledby="qText">
      <div class="q-meta">${agentDot}<span>Агент</span></div>
      <h2 class="q-text" id="qText" tabindex="-1">Получаем следующий вопрос</h2>
      <button class="btn btn-secondary" data-action="question-retry" type="button">Получить вопрос</button>
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
    if (['starting', 'stopping', 'saving', 'skipping', 'uploading', 'loading'].includes(t.rec)) {
      const labels = {starting: 'Разрешите доступ к микрофону…', stopping: 'Завершаем расшифровку и сохраняем запись…',
        saving: 'Сохраняем ответ, ищем людей и готовим следующий вопрос…', skipping: 'Готовим другой вопрос…',
        uploading: 'Загружаем фотографию…', loading: 'Получаем вопрос…'};
      return `<p class="help" role="status" aria-live="polite">${esc(labels[t.rec])}</p>`;
    }
    if (t.rec === 'recording') {
      return `<div class="rec-row">
          <button class="rec-btn is-recording" type="button" data-action="rec-stop" aria-label="Остановить запись">${icon('i-stop')}</button>
          <div class="od-field" style="--od-gap:6px"><span class="live-dot">Идёт запись</span><span class="timer" id="recTimer">0:00</span></div>
          <div class="levels" id="levels" aria-hidden="true">${'<i></i>'.repeat(28)}</div>
        </div>
        <div class="field" style="margin-top:16px">
          <p class="help" id="liveStatus" role="status">${esc(t.liveStatus || 'Текст появляется по мере речи. Последние слова могут уточняться.')}</p>
          <p id="liveTranscript" style="white-space:pre-wrap;min-height:3em">${esc(t.liveText || 'Говорите — здесь появится расшифровка…')}</p>
        </div>
        <div class="rec-foot"><button class="btn btn-ghost btn-sm" type="button" data-action="rec-cancel">${icon('i-x')}<span>Отменить запись</span></button></div>`;
    }
    if (t.rec === 'processing') {
      return `<p class="help" role="status">${t.audio ? 'Повторно расшифровываем сохранённую запись…' : 'Передаём запись и расшифровываем речь…'}</p>`;
    }
    if (t.rec === 'error') {
      return `<div class="alert" role="alert">${icon('i-alert')}
        <div class="od-stack" style="--od-gap:4px">
          <strong>Не получилось расшифровать запись</strong>
          <span>${esc(t.error || 'Попробуйте снова.')} ${t.audio ? 'Исходная запись сохранена на сервере.' : t.localSaved ? 'Запись сохранена на этом устройстве.' : 'Запись доступна в этой вкладке; не закрывайте её.'}</span>
          <div class="od-cluster" style="margin-top:8px">
            <button class="btn btn-primary btn-sm" type="button" data-action="rec-retry">${icon('i-refresh')}<span>Повторить расшифровку</span></button>
            <button class="btn btn-secondary btn-sm" type="button" data-action="rec-again"${t.pendingAnswer ? ' disabled' : ''}>Записать заново</button>
          </div>
        </div>
      </div>`;
    }
    if (t.rec === 'review') {
      return `<div class="od-stack" style="--od-gap:16px">
        ${t.saveError ? `<p class="err" role="alert">${esc(t.saveError)}</p>` : ''}
        <div class="player">${voiceBtn('draft', fmtTime(t.dur), 'Прослушать ответ')}</div>
        <div class="field" style="margin:0">
          <label for="draft">Расшифровка</label>
          <p class="help" id="draftHelp">Проверьте текст и исправьте, если что-то распознано неверно. Запись останется в исходном виде.</p>
          <textarea class="input" id="draft" rows="5"${t.pendingAnswer ? ' readonly' : ''} aria-describedby="draftHelp">${esc(t.draft)}</textarea>
        </div>
        <div class="od-cluster">
          <button class="btn btn-primary" type="button" data-action="save-answer">${icon('i-check')}<span>Сохранить ответ</span></button>
          <button class="btn btn-ghost" type="button" data-action="rec-again"${t.pendingAnswer ? ' disabled' : ''}>Записать заново</button>
        </div>
      </div>`;
    }
    if (t.rec === 'typing') {
      return `${t.saveError ? `<p class="err" role="alert">${esc(t.saveError)}</p>` : ''}<div class="field" style="margin:0">
          <label for="typed">Ваш ответ</label>
          <p class="help" id="typedHelp">Напишите так, как рассказали бы вслух.</p>
          <textarea class="input" id="typed" rows="5"${t.pendingAnswer ? ' readonly' : ''} aria-describedby="typedHelp typedErr">${esc(t.typedDraft || '')}</textarea>
          <p class="err" id="typedErr" hidden>${icon('i-alert', 'ico-sm')}<span>Напишите хотя бы пару слов — или вернитесь к записи голосом.</span></p>
        </div>
        <div class="od-cluster">
          <button class="btn btn-primary" type="button" data-action="save-typed">${icon('i-check')}<span>Сохранить ответ</span></button>
          <button class="btn btn-ghost" type="button" data-action="rec-idle"${t.pendingAnswer ? ' disabled' : ''}>${icon('i-mic')}<span>Ответить голосом</span></button>
        </div>`;
    }
    return `<div class="rec-row">
        <button class="rec-btn" type="button" data-action="rec-start" aria-label="Записать ответ">${icon('i-mic')}</button>
        <div class="rec-text"><strong>Нажмите и расскажите</strong><span>До 5 минут за один ответ. Текст появляется во время речи; после остановки его можно исправить.</span></div>
      </div>
      <div class="rec-foot"><button class="btn btn-ghost btn-sm" type="button" data-action="rec-type">${icon('i-text')}<span>Ответить текстом</span></button><button class="btn btn-ghost btn-sm" type="button" data-action="audio-upload">${icon('i-upload')}<span>Загрузить аудио</span></button><input id="audioUpload" type="file" accept="audio/*" hidden></div>`;
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

  /* ---------- воспроизведение оригинальной записи ---------- */
  const V = {btn: null, audio: null};
  function stopVoice() {
    if (V.audio) { V.audio.pause(); V.audio.onended = V.audio.onerror = null; }
    if (V.btn) {
      V.btn.setAttribute('aria-pressed', 'false');
      const pp = $('.pp', V.btn); if (pp) pp.innerHTML = icon('i-play', 'ico-sm');
      const bar = $('.voice-track i', V.btn); if (bar) bar.style.transform = 'scaleX(0)';
      const d = $('.v-dur', V.btn); if (d) d.textContent = V.btn.dataset.dur;
    }
    V.btn = V.audio = null;
  }
  function toggleVoice(btn) {
    if (V.btn === btn) { stopVoice(); return; }
    stopVoice(); stopSpeak();
    const key = btn.dataset.key;
    let url;
    if (key === 'draft') {
      const t = getStory(S.route.sid)?.talk;
      url = t?.blobUrl || t?.audio;
    } else if (key.startsWith('q-')) {
      const cut = key.lastIndexOf('-');
      const block = S.chapters[key.slice(2, cut)]?.blocks[Number(key.slice(cut + 1))];
      url = S.sources[block?.src]?.audio;
    } else { url = S.sources[key.replace(/^(turn|m|s)-/, '')]?.audio; }
    if (!url) { toast('У этого ответа нет аудиофайла'); return; }
    const audio = new Audio(url);
    V.audio = audio; V.btn = btn;
    btn.setAttribute('aria-pressed', 'true');
    $('.pp', btn).innerHTML = icon('i-pause', 'ico-sm');
    audio.ontimeupdate = () => {
      const duration = Number.isFinite(audio.duration) ? audio.duration : parseDur(btn.dataset.dur);
      const bar = $('.voice-track i', btn); if (bar) bar.style.transform = `scaleX(${duration ? Math.min(1, audio.currentTime / duration) : 0})`;
      const label = $('.v-dur', btn); if (label) label.textContent = `${fmtTime(audio.currentTime)} / ${fmtTime(duration)}`;
    };
    const failed = () => { if (V.audio === audio) { stopVoice(); toast('Не получилось воспроизвести запись'); } };
    audio.onended = () => { if (V.audio === audio) stopVoice(); };
    audio.onerror = failed;
    audio.play().catch(failed);
  }

  /* ---------- озвучка вопроса ---------- */
  function setSpeakBtn(on) {
    const b = $('[data-action="speak"]');
    if (!b) return;
    b.setAttribute('aria-pressed', String(on));
    $('span', b).textContent = on ? 'Остановить озвучку' : 'Прослушать вопрос';
    $('use', b).setAttribute('href', on ? '#i-stop' : '#i-volume');
  }
  let questionAudio = null;
  let speechToken = 0;
  function stopSpeak() {
    speechToken += 1;
    if (questionAudio) { questionAudio.pause(); questionAudio.onerror = null; questionAudio = null; }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    setSpeakBtn(false);
  }
  function speak() {
    if (getStory(S.route.sid)?.talk.rec === 'recording') { toast('Сначала остановите запись'); return; }
    if (questionAudio || window.speechSynthesis?.speaking) { stopSpeak(); return; }
    const text = $('#qText')?.textContent;
    if (!text) return;
    stopVoice(); stopSpeak();
    const token = speechToken;
    let usedFallback = false;
    const fallback = () => {
      if (token !== speechToken || usedFallback) return;
      usedFallback = true;
      if (questionAudio) questionAudio.pause();
      questionAudio = null;
      const synth = window.speechSynthesis;
      if (!synth || !window.SpeechSynthesisUtterance) { setSpeakBtn(false); toast('Озвучка недоступна — вопрос можно прочитать'); return; }
      toast('Яндекс не озвучил вопрос — используем голос браузера');
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ru-RU'; u.rate = 0.95;
      const ru = synth.getVoices().find(v => /^ru/i.test(v.lang)); if (ru) u.voice = ru;
      u.onend = u.onerror = () => { if (token === speechToken) setSpeakBtn(false); };
      synth.speak(u);
    };
    questionAudio = new Audio(API.ttsUrl(text));
    questionAudio.onerror = fallback;
    questionAudio.onended = () => { if (token === speechToken) { questionAudio = null; setSpeakBtn(false); } };
    setSpeakBtn(true);
    questionAudio.play().catch(fallback);
  }

  /* ---------- запись и обработка ответа ---------- */
  function clearRecTimers() {
    clearInterval(S.timers.rec);
    clearInterval(S.timers.levels);
    clearTimeout(S.timers.proc);
  }
  function redrawTalk(s, focus) {
    if (parseRoute().sid === s.id && parseRoute().view === 'talk') rerender(focus);
  }
  function mergeStory(s, incoming) {
    Object.assign(s, incoming);
    s.talk.session = incoming.interview?.session || s.talk.session;
    s.talk.turns = clone(incoming.interview?.turns || []);
  }
  async function persistDraft(s) {
    const t = s.talk;
    try {
      await PomnuVoice.draft('put', s.id, {session: t.session, blob: t.blob, audio: t.audio, dur: t.dur,
        draft: t.draft, original: t.original, typedDraft: t.typedDraft, photo: t.photo,
        saveKey: t.saveKey, pendingAnswer: t.pendingAnswer, mode: t.rec});
      t.localSaved = true;
    } catch (_) { t.localSaved = false; }
  }
  async function discardDraft(s) {
    const t = s.talk;
    if (t.blobUrl) URL.revokeObjectURL(t.blobUrl);
    Object.assign(t, {blob: null, blobUrl: null, audio: null, draft: '', original: '', typedDraft: '',
      saveKey: null, pendingAnswer: null, localSaved: false, saveError: '', error: ''});
    try { await PomnuVoice.draft('delete', s.id); } catch (_) { toast('Не удалось удалить локальный черновик'); }
  }
  async function startRec(s) {
    if (!D.server) { toast('Запустите Python-сервер по README'); return; }
    if (locked(s.talk)) return;
    stopSpeak(); stopVoice();
    const t = s.talk;
    t.liveText = ''; t.liveStatus = '';
    t.rec = 'starting'; redrawTalk(s, '#recorder');
    try {
      await PomnuVoice.start(level => {
        if (S.route.sid !== s.id) return;
        $$('#levels i').forEach(b => { b.style.transform = `scaleY(${Math.max(0.08, level)})`; });
      }, () => { if (t.rec === 'recording') { toast('Пять минут записаны — обрабатываем ответ'); stopRec(s); } }, error => {
        clearRecTimers(); t.rec = 'idle'; redrawTalk(s); toast(error.message);
      }, {
        url: API.liveUrl(s.id),
        onTranscript(message) {
          t.liveText = [message.final, message.partial].filter(Boolean).join(' ');
          if (parseRoute().sid === s.id && $('#liveTranscript')) $('#liveTranscript').textContent = t.liveText || 'Слушаю…';
        },
        onStatus(message) {
          t.liveStatus = message;
          if (parseRoute().sid === s.id && $('#liveStatus')) $('#liveStatus').textContent = message;
        }
      });
      t.rec = 'recording'; t.recStart = performance.now();
      if (parseRoute().sid !== s.id || parseRoute().view !== 'talk') { await cancelRec(s); return; }
      redrawTalk(s, '[data-action="rec-stop"]');
      S.timers.rec = setInterval(() => {
        if (S.route.sid === s.id && $('#recTimer')) $('#recTimer').textContent = fmtTime((performance.now() - t.recStart) / 1000);
      }, 250);
      announce('Идёт запись. Нажмите «Остановить запись», когда закончите.');
    } catch (e) {
      t.rec = 'idle'; redrawTalk(s);
      toast(e.name === 'NotAllowedError' ? 'Нет доступа к микрофону. Разрешите его в браузере или ответьте текстом.' : e.message);
    }
  }
  async function cancelRec(s) {
    clearRecTimers(); await PomnuVoice.cancel();
    s.talk.rec = 'idle'; redrawTalk(s, '[data-action="rec-start"]');
  }
  async function procTick(s) {
    const t = s.talk;
    t.rec = 'processing'; t.error = ''; redrawTalk(s, '#recorder');
    try {
      const result = t.audio ? await API.retryTranscribe(s.id, t.audio) : await API.transcribe(s.id, t.blob);
      t.audio = result.audio;
      if (result.dur) t.dur = parseDur(result.dur);
      t.original = result.text; t.draft = result.text; t.rec = 'review';
      await persistDraft(s);
      redrawTalk(s, '#draft'); announce('Расшифровка готова. Проверьте текст и сохраните ответ.');
    } catch (e) {
      if (e.data?.audio) t.audio = e.data.audio;
      t.error = e.message || 'Проверьте соединение и попробуйте снова'; t.rec = 'error';
      await persistDraft(s); redrawTalk(s, '[data-action="rec-retry"]');
    }
  }
  async function acceptRecording(s, blob, duration, live = null) {
    const t = s.talk;
    if (t.blobUrl) URL.revokeObjectURL(t.blobUrl);
    Object.assign(t, {blob, blobUrl: URL.createObjectURL(blob), audio: null, dur: duration,
      original: '', draft: '', saveKey: null, pendingAnswer: null, saveError: ''});
    await persistDraft(s);
    if (!t.localSaved) toast('Не удалось сохранить черновик на устройстве. Не закрывайте вкладку до отправки.');
    live = await live;
    if (live?.text && live?.audio) {
      t.audio = live.audio; t.original = live.text; t.draft = live.text; t.rec = 'review';
      if (live.dur) t.dur = parseDur(live.dur);
      await persistDraft(s); redrawTalk(s, '#draft');
      announce('Расшифровка готова. Проверьте текст и сохраните ответ.');
    } else await procTick(s);
  }
  async function stopRec(s) {
    const t = s.talk;
    if (t.rec !== 'recording') return;
    clearRecTimers(); t.rec = 'stopping'; redrawTalk(s, '#recorder');
    try { const {blob, duration, live} = await PomnuVoice.stop(); await acceptRecording(s, blob, duration, live); }
    catch (e) { t.rec = 'idle'; redrawTalk(s); toast(e.message); }
  }
  async function retryRec(s) {
    if (s.talk.rec === 'error') await procTick(s);
  }
  async function saveAnswer(s, typedText) {
    const t = s.talk;
    if (!['typing', 'review'].includes(t.rec)) return;
    const typed = typeof typedText === 'string';
    const text = (typed ? typedText : ($('#draft')?.value ?? t.draft)).trim();
    if (!text) { toast('Ответ не может быть пустым'); return; }
    const previous = t.rec;
    t.draft = typed ? t.draft : text;
    t.typedDraft = typed ? text : t.typedDraft;
    // Повтор после неизвестного результата использует тот же снимок и ключ.
    t.saveKey ||= crypto.randomUUID();
    t.pendingAnswer ||= {text, typed, edited: !typed && text !== t.original,
      audio: typed ? null : t.audio, dur: typed ? '0:00' : fmtTime(t.dur), photo: t.photo};
    t.rec = 'saving'; stopSpeak(); stopVoice();
    await persistDraft(s); redrawTalk(s, '#recorder');
    try {
      const result = await API.answer(s.id, t.pendingAnswer, t.saveKey);
      S.sources[result.sourceId] = result.source;
      Object.assign(S.people, result.added.people); Object.assign(S.places, result.added.places);
      for (const ev of result.added.events) { if (!S.events.some(x => x.id === ev.id)) S.events.push(ev); }
      Object.keys(result.added.people).forEach(id => S.fresh.add(id));
      Object.keys(result.added.places).forEach(id => S.fresh.add(id));
      mergeStory(s, result.story);
      await discardDraft(s); t.photo = null; t.photoQ = null; t.rec = 'idle';
      S.qEnter = true; redrawTalk(s, '#qText');
      const count = Object.keys(result.added.people).length + Object.keys(result.added.places).length + result.added.events.length;
      toast(count ? `Ответ сохранён. Новых материалов: ${count}` : 'Ответ сохранён');
    } catch (e) {
      if (e.data?.sourceId) {
        // Источник уже сохранён, но один из агентов не ответил: повторять ответ нельзя.
        try {
          const state = await API.state();
          Object.assign(S.sources, state.sources); Object.assign(S.people, state.people); Object.assign(S.places, state.places);
          S.events = state.events;
          const updated = state.stories.find(x => x.id === s.id); if (updated) mergeStory(s, updated);
          await discardDraft(s); t.photo = null; t.rec = 'idle';
          toast('Ответ сохранён, но обработка агентами не завершилась. Проверьте материалы перед продолжением.');
          await loadQuestion(s, true);
          return;
        } catch (_) { /* Локальный черновик остаётся до успешной сверки. */ }
      }
      t.rec = previous;
      t.saveError = e.data?.sourceId ? 'Ответ уже на сервере. Повторите для сверки состояния.' : 'Не удалось подтвердить сохранение. Повтор отправит тот же ответ без дубликата.';
      redrawTalk(s, typed ? '#typed' : '#draft'); toast(t.saveError);
    }
  }
  async function skipQuestion(s, declined) {
    const t = s.talk;
    if (locked(t) || !currentQuestion(s)) return;
    stopSpeak(); t.rec = 'skipping'; redrawTalk(s, '#recorder');
    try {
      const result = await API.skip(s.id, declined);
      mergeStory(s, result.story); await discardDraft(s);
      t.photo = null; t.rec = 'idle'; S.qEnter = true; redrawTalk(s, '#qText');
      toast(declined ? 'Хорошо, к этой теме больше не вернусь' : 'Вопрос отложен — тема осталась в списке');
    } catch (e) { t.rec = 'idle'; redrawTalk(s); toast(e.message); }
  }
  async function loadQuestion(s, force = false) {
    if (!D.server || s.talk.loadingQuestion || (!force && currentQuestion(s))) return;
    s.talk.loadingQuestion = true;
    try { const q = await API.question(s.id); s.interview ||= {}; s.interview.question = q; redrawTalk(s, '#qText'); }
    catch (_) { toast('Не удалось получить вопрос. Нажмите «Получить вопрос» для повтора.'); }
    finally { s.talk.loadingQuestion = false; }
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

  async function loadImage(file) {
    if (!file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Выберите JPEG, PNG или WebP');
    if (file.size > 10 * 1024 * 1024) throw new Error('Фотография должна быть меньше 10 МБ');
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error('Не удалось прочитать изображение')); img.src = url; });
      const result = await API.upload(file);
      return {...result, w: img.naturalWidth, h: img.naturalHeight};
    } finally { URL.revokeObjectURL(url); }
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
    C.photo = null; C.uploading = false; C.uploadToken = (C.uploadToken || 0) + 1;
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
  async function createStory() {
    const narrator = $('#f-narrator').value.trim();
    const about = $('#f-about').value.trim();
    const relation = /^я$/i.test(narrator) ? 'я' : $('#f-relation').value;
    const s = await API.createStory({type: selectedType(), title: about.charAt(0).toUpperCase() + about.slice(1),
      about, narrator: relation === 'я' ? D.user.name : narrator, relation, cover: C.photo});
    s.demo = false; s.talk = newTalk(s.interview?.session || 1);
    s.talk.photo = s.interview?.photo || C.photo;
    S.stories.unshift(s);
    return s.id;
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
    if (questionAudio || window.speechSynthesis?.speaking) setSpeakBtn(true);
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
    S.stories.forEach(s => {
      if (s.talk.rec === 'recording') stopRec(s);
    });
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
    const current = getStory(S.route.sid);
    if (current && S.route.view === 'talk') loadQuestion(current);
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
      case 'rec-cancel': if (s) cancelRec(s); break;
      case 'rec-retry': if (s) retryRec(s); break;
      case 'rec-again': if (s && !t.pendingAnswer) { discardDraft(s).then(() => { t.rec = 'idle'; redrawTalk(s); }); } break;
      case 'audio-upload': $('#audioUpload')?.click(); break;
      case 'question-retry': if (s) loadQuestion(s, true); break;
      case 'rec-type': if (s) { t.rec = 'typing'; rerender('#typed'); } break;
      case 'rec-idle': if (s && !t.pendingAnswer) { t.rec = 'idle'; rerender('[data-action="rec-start"]'); } break;
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
      case 'remove-photo': if (s) { t.photo = null; t.photoQ = null; persistDraft(s); rerender('#qText'); toast('Фото убрано'); } break;
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

  document.addEventListener('change', async (e) => {
    const input = e.target;
    if (input.id === 'audioUpload') {
      const story = getStory(S.route.sid); const file = input.files?.[0]; input.value = '';
      if (!story || !file || locked(story.talk)) return;
      if (file.size > 25 * 1024 * 1024) { toast('Аудиофайл должен быть меньше 25 МБ'); return; }
      story.talk.rec = 'stopping'; redrawTalk(story);
      await acceptRecording(story, file, 0);
    } else if (input.id === 'photoInput') {
      const s = S.route.sid ? getStory(S.route.sid) : null;
      const file = input.files && input.files[0];
      input.value = '';
      if (!s || !file) return;
      const previous = s.talk.rec; s.talk.rec = 'uploading'; redrawTalk(s);
      loadImage(file).then((ph) => {
        s.talk.photo = ph;
        s.talk.rec = previous; persistDraft(s);
        S.qEnter = true;
        rerender('#qText', true);
        toast('Фото прикреплено к следующему ответу');
      }).catch(e => { s.talk.rec = previous; redrawTalk(s); toast(e.message); });
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
      const uploadToken = C.uploadToken = (C.uploadToken || 0) + 1;
      C.uploading = true; $('#createSubmit').disabled = true;
      loadImage(file).then((ph) => {
        if (C.uploadToken !== uploadToken) return;
        C.photo = ph;
        $('#photoRow').innerHTML = `<img class="file-thumb" src="${esc(ph.src)}" width="${ph.w}" height="${ph.h}" alt="Выбранное фото"><button class="btn btn-ghost btn-sm" type="button" data-action="clear-start-photo">Убрать фото</button>`;
      }).catch(e => toast(e.message)).finally(() => { if (C.uploadToken === uploadToken) { C.uploading = false; $('#createSubmit').disabled = false; } });
    }
  });

  ['narrator', 'about'].forEach((name) => {
    const f = $(`#f-${name}`);
    f.addEventListener('blur', () => { if (C.step === 2 && $('#createDialog').open) validate(name); });
    f.addEventListener('input', () => { if (f.classList.contains('is-invalid')) validate(name); });
  });
  document.addEventListener('input', (e) => {
    const story = getStory(S.route.sid);
    if (story && ['draft', 'typed'].includes(e.target.id)) {
      story.talk[e.target.id === 'draft' ? 'draft' : 'typedDraft'] = e.target.value;
      persistDraft(story);
    }
    if (e.target.id === 'typed' && e.target.value.trim()) {
      e.target.classList.remove('is-invalid');
      e.target.removeAttribute('aria-invalid');
      const err = $('#typedErr');
      if (err) err.hidden = true;
    }
  });

  $('#createForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (C.uploading || $('#createSubmit').disabled) return;
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
    try {
      const id = await createStory();
      $('#createDialog').close();
      location.hash = `#/s/${id}/talk`;
      toast('История создана — первый вопрос уже ждёт');
    } catch (e) { toast(`Не получилось создать историю: ${e.message}`); }
    finally { btn.disabled = false; btn.removeAttribute('aria-busy'); $('span', btn).textContent = 'Начать разговор'; }
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

  window.addEventListener('beforeunload', e => {
    if (S.stories.some(s => ['starting', 'recording', 'stopping', 'saving', 'processing'].includes(s.talk.rec))) {
      e.preventDefault(); e.returnValue = '';
    }
  });
  async function bootVoice() {
    for (const story of S.stories) {
      try {
        const draft = await PomnuVoice.draft('get', story.id);
        if (draft && draft.session === story.talk.session) {
          Object.assign(story.talk, draft, {localSaved: true});
          if (draft.blob) story.talk.blobUrl = URL.createObjectURL(draft.blob);
          story.talk.rec = draft.pendingAnswer?.typed || draft.mode === 'typing' ? 'typing' : draft.draft ? 'review' : draft.typedDraft ? 'typing' : draft.blob || draft.audio ? 'error' : 'idle';
          if (draft.pendingAnswer) story.talk.saveError = 'Сохранение ещё не подтверждено. Нажмите «Сохранить ответ»: повтор использует прежний текст и не создаст дубликат.';
        }
      } catch (_) { /* Блокировка IndexedDB не мешает открыть приложение. */ }
    }
    navigate();
    if (D.server) API.health().then(h => { if (h.mock) toast('MOCK: запись настоящая, распознавание и агенты работают на тестовых ответах'); }).catch(() => {});
  }
  bootVoice();
})();
