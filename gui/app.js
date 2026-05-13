/**
 * AI Advisory Board UI client.
 *
 * Single-file vanilla JS app. Talks to the local Express server via REST
 * for read/write and WebSocket (ws://host:port/ws) for live discussion
 * progress. No build step — served directly by the server.
 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ------------------------------------------------------------------
// State
// ------------------------------------------------------------------

const state = {
  workspace: null,
  settings: null,
  members: [],
  principles: [],
  actionItems: [],
  discussions: [],
  currentDiscussion: null,
  /** Track in-flight typing bubbles per discussion-pending scope. */
  pendingTyping: new Map(), // memberName -> DOM element
  ws: null,
  route: 'discussions',
  followUpComposerOpen: false,
};

// Member colors mirror the agent file's `color:` field — we get them from
// the API. Fallback rotates through the known palette deterministically.
const FALLBACK_PALETTE = ['cyan', 'green', 'yellow', 'magenta', 'blue', 'red', 'orange', 'pink', 'purple'];
function colorForMember(name) {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return FALLBACK_PALETTE[h % FALLBACK_PALETTE.length];
}

// ------------------------------------------------------------------
// Bootstrap
// ------------------------------------------------------------------

async function bootstrap() {
  await refreshState({ silent: true });
  renderWorkspaceCard();
  connectWebSocket();
  setupNav();
  setupModal();
  setupEditModal();
  setupConfirmModal();
  navigate('discussions');
}

async function refreshState(opts = {}) {
  try {
    const data = await fetchJSON('/api/state');
    Object.assign(state, {
      workspace: data.workspace,
      settings: data.settings,
      members: data.members || [],
      principles: data.principles || [],
      actionItems: data.actionItems || [],
      discussions: data.discussions || [],
    });
    if (data.workspace?.id) $('#workspace-label').textContent = data.workspace.id;
  } catch (e) {
    if (!opts.silent) toast('Failed to refresh state: ' + e.message, 'err');
    else toast('Failed to load workspace state: ' + e.message, 'err');
  }
}

function renderWorkspaceCard() {
  const card = $('#workspace-card');
  if (!card || !state.workspace) return;
  card.hidden = false;
  const activeCount = (state.members || []).filter((m) => m.isActive).length;
  $('#ws-scope-pill').textContent = state.workspace.scope === 'project' ? 'project' : 'home';
  $('#ws-scope-pill').className = 'ws-pill ' + (state.workspace.scope === 'project' ? 'project' : 'home');
  $('#ws-member-count').textContent = `${activeCount}/${state.members.length} active`;
  $('#ws-root-path').textContent = state.workspace.root || '';
  $('#ws-root-path').title = state.workspace.root || '';
}

function connectWebSocket() {
  const url = `ws://${location.host}/ws`;
  const ws = new WebSocket(url);
  state.ws = ws;
  ws.addEventListener('open', () => setWsStatus('connected', 'ok'));
  ws.addEventListener('close', () => {
    setWsStatus('disconnected', 'err');
    setTimeout(connectWebSocket, 2000);
  });
  ws.addEventListener('error', () => setWsStatus('error', 'err'));
  ws.addEventListener('message', (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      handleWsMessage(msg);
    } catch {
      /* ignore */
    }
  });
}

function setWsStatus(label, kind) {
  $('#ws-label').textContent = label;
  $('#ws-dot').className = 'status-dot ' + (kind || '');
}

// ------------------------------------------------------------------
// WebSocket handlers
// ------------------------------------------------------------------

function handleWsMessage(msg) {
  if (msg.type === 'member_thinking') {
    addTypingBubble(msg.memberName);
  } else if (msg.type === 'member_activity') {
    updateTypingActivity(msg.memberName, msg.activity, msg.detail);
  } else if (msg.type === 'member_response') {
    // The server includes the name at top-level too for symmetry, but the
    // canonical source is `msg.response.memberName`.
    const name = msg.memberName || msg.response?.memberName;
    replaceTypingWithResponse(name, msg.response);
  } else if (msg.type === 'orchestrator_thinking') {
    // Optional: show a system "Orchestrator analyzing..." line
    addSystemLine('Orchestrator analyzing the round…');
  } else if (msg.type === 'orchestrator_decision') {
    addOrchestratorDecision(msg.decision);
  } else if (msg.type === 'discussion_gated') {
    // Pre-round gate fired — no members actually spawned. Clear any
    // optimistic typing bubbles so they don't sit forever.
    state.pendingTyping.forEach((b) => b.remove());
    state.pendingTyping.clear();
    state.currentDiscussion = msg.discussion;
    updateDiscussionList(msg.discussion);
    finalizeChat(msg, { gated: true });
  } else if (msg.type === 'discussion_completed') {
    state.currentDiscussion = msg.discussion;
    updateDiscussionList(msg.discussion);
    finalizeChat(msg);
  } else if (msg.type === 'error') {
    toast(msg.message, 'err');
    // Re-enable any disabled action buttons so the user can retry
    setActionButtonsBusy(false);
  }
}

// ------------------------------------------------------------------
// Navigation
// ------------------------------------------------------------------

function setupNav() {
  $$('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => navigate(btn.dataset.route));
  });
}

function navigate(route) {
  state.route = route;
  $$('.nav-item').forEach((btn) => btn.classList.toggle('active', btn.dataset.route === route));
  const main = $('#main');
  main.innerHTML = '';
  if (route === 'discussions') renderDiscussionsView(main);
  else if (route === 'members') renderMembersView(main);
  else if (route === 'actions') renderActionsView(main);
  else if (route === 'principles') renderPrinciplesView(main);
  else if (route === 'settings') renderSettingsView(main);
}

// ------------------------------------------------------------------
// Discussions list view
// ------------------------------------------------------------------

function renderDiscussionsView(main) {
  const view = h('div', { class: 'view' });

  const header = h('div', { class: 'view-header' });
  header.appendChild(
    h('div', {}, [
      h('div', { class: 'view-title' }, 'Discussions'),
      h('div', { class: 'view-subtitle' }, `${state.discussions.length} saved`),
    ]),
  );
  const newBtn = h('button', { class: 'btn-primary' }, '+ New discussion');
  newBtn.addEventListener('click', openNewDiscussionModal);
  header.appendChild(newBtn);
  view.appendChild(header);

  const body = h('div', { class: 'view-body' });

  if (state.discussions.length === 0) {
    body.appendChild(emptyState('💬', 'No discussions yet', 'Click "New discussion" to convene the board.'));
  } else {
    const list = h('div', { class: 'discussion-list' });
    state.discussions.forEach((d) => list.appendChild(renderDiscussionCard(d)));
    body.appendChild(list);
  }

  view.appendChild(body);
  main.appendChild(view);
}

function renderDiscussionCard(d) {
  const card = h('div', { class: 'discussion-card' });
  card.appendChild(h('div', { class: 'discussion-card-q' }, d.question));

  const status = d.completedAt ? 'done' : d.pendingUserRequest ? 'awaiting' : 'open';
  const statusLabel = status === 'done' ? 'concluded' : status === 'awaiting' ? 'awaiting input' : 'open';

  const meta = h('div', { class: 'discussion-card-meta' });
  meta.appendChild(h('span', { class: `status-pill ${status}` }, statusLabel));
  meta.appendChild(h('span', {}, `${d.rounds.length} round${d.rounds.length === 1 ? '' : 's'}`));
  meta.appendChild(h('span', {}, `${d.totalTurns} turn${d.totalTurns === 1 ? '' : 's'}`));
  meta.appendChild(h('span', {}, formatRelative(d.createdAt)));
  card.appendChild(meta);

  card.addEventListener('click', () => openChatView(d));
  return card;
}

// ------------------------------------------------------------------
// Chat view
// ------------------------------------------------------------------

function openChatView(discussion) {
  state.currentDiscussion = discussion;
  state.pendingTyping.clear();
  state.followUpComposerOpen = false;
  const main = $('#main');
  main.innerHTML = '';

  const view = h('div', { class: 'view chat-view' });

  // Header
  const header = h('div', { class: 'view-header' });
  const back = h('button', { class: 'btn-secondary' }, '← Back');
  back.addEventListener('click', () => navigate('discussions'));
  header.appendChild(back);
  header.appendChild(h('div', { class: 'chat-header-q' }, discussion.question));
  header.appendChild(h('div', {}, '')); // spacer
  view.appendChild(header);

  // Stream
  const stream = h('div', { class: 'chat-stream', id: 'chat-stream' });
  for (const node of discussionTimeline(discussion)) stream.appendChild(node);
  if (discussion.pendingUserRequest) {
    stream.appendChild(pendingRequestBubble(discussion.pendingUserRequest));
  }
  view.appendChild(stream);

  // Action footer (continue / respond)
  view.appendChild(renderChatFooter(discussion));

  main.appendChild(view);
  scrollChat();
}

// Walk a saved discussion and return DOM nodes in chat-app order:
// - the user's initial question
// - per round: round divider, any user reply that triggered the round,
//   each member response, then the orchestrator decision
function discussionTimeline(discussion) {
  const nodes = [];
  const userResponses = discussion.userResponses || [];

  const initial = userResponses.find((u) => u.type === 'initial_question');
  if (initial) nodes.push(userBubble(initial.content, 'Question'));
  else if (discussion.question) nodes.push(userBubble(discussion.question, 'Question'));

  for (const round of discussion.rounds || []) {
    nodes.push(roundDivider(round.roundNumber));

    // HITL reply that triggered THIS round was attached with
    // roundNumber = previous round's number.
    const hitlReply = userResponses.find(
      (u) => u.type === 'advisory_board_requested' && u.roundNumber === round.roundNumber - 1,
    );
    if (hitlReply && round.roundNumber > 1) {
      nodes.push(userBubble(hitlReply.content, 'Your reply', hitlReply.selectedOption));
    }

    if (round.userResponse && round.userResponse.type === 'follow_up_question') {
      const target =
        round.followUpTargetType === 'specific'
          ? '· targeted'
          : round.followUpTargetType === 'subset'
            ? '· subset'
            : '';
      nodes.push(userBubble(round.userResponse.content, `Follow-up ${target}`.trim()));
    }

    for (const r of round.responses) nodes.push(messageBubble(r));
    if (round.orchestratorDecision) nodes.push(orchestratorBubble(round.orchestratorDecision));
  }
  return nodes;
}

function renderChatFooter(discussion) {
  const footer = h('div', { class: 'chat-footer', id: 'chat-footer' });
  if (discussion.completedAt) {
    footer.appendChild(h('div', { class: 'message-meta' }, '✓ Discussion concluded.'));
    return footer;
  }
  if (discussion.pendingUserRequest) {
    footer.appendChild(renderRespondForm(discussion));
    return footer;
  }
  // Open discussion → Continue + Follow up buttons (or active follow-up composer)
  if (state.followUpComposerOpen) {
    footer.appendChild(renderFollowUpComposer(discussion));
    return footer;
  }
  const row = h('div', { class: 'chat-actions' });
  const cont = h('button', { class: 'btn-primary', id: 'btn-continue' }, '▸ Continue discussion');
  cont.addEventListener('click', () => triggerContinue(discussion));
  row.appendChild(cont);
  const followBtn = h('button', { class: 'btn-secondary', id: 'btn-follow-up' }, '↳ Follow up');
  followBtn.addEventListener('click', () => {
    state.followUpComposerOpen = true;
    refreshChatFooter(discussion);
  });
  row.appendChild(followBtn);
  footer.appendChild(row);

  const turnsLeft = (discussion.maxTurns ?? 0) - (discussion.totalTurns ?? 0);
  footer.appendChild(
    h(
      'div',
      { class: 'message-meta', style: 'margin-top:6px' },
      `${discussion.totalTurns}/${discussion.maxTurns} turns used · ${turnsLeft} left`,
    ),
  );
  return footer;
}

function renderFollowUpComposer(discussion) {
  const wrap = h('div', { class: 'respond-form follow-up-form' });
  wrap.appendChild(h('div', { class: 'struct-section-title' }, 'Follow-up question'));

  const textarea = h('textarea', {
    id: 'follow-up-input',
    rows: '3',
    placeholder: 'Ask the board a sharper question, or push back on a specific point…',
  });
  wrap.appendChild(textarea);

  // Member selector — defaults to all of the discussion's members selected.
  const allowedIds = new Set(discussion.selectedMemberIds ?? state.members.map((m) => m.id));
  const candidates = state.members.filter((m) => allowedIds.has(m.id) && m.isActive);
  const selectedSet = new Set(candidates.map((m) => m.id));

  wrap.appendChild(
    h('div', { class: 'message-meta', style: 'margin-top:4px' }, 'Who should answer? (deselect to narrow)'),
  );
  const chips = h('div', { class: 'respond-options follow-up-chips' });
  candidates.forEach((m) => {
    const chip = h('button', { class: 'chip selected', type: 'button', 'data-member-id': m.id });
    chip.appendChild(h('div', { class: 'avatar', 'data-color': m.color || colorForMember(m.name) }, m.initials || initialsOf(m.name)));
    chip.appendChild(h('span', {}, m.name));
    chip.addEventListener('click', () => {
      if (selectedSet.has(m.id)) {
        selectedSet.delete(m.id);
        chip.classList.remove('selected');
      } else {
        selectedSet.add(m.id);
        chip.classList.add('selected');
      }
    });
    chips.appendChild(chip);
  });
  wrap.appendChild(chips);

  const actions = h('div', { class: 'chat-actions', style: 'justify-content:flex-end;width:100%' });
  const cancel = h('button', { class: 'btn-secondary' }, 'Cancel');
  cancel.addEventListener('click', () => {
    state.followUpComposerOpen = false;
    refreshChatFooter(discussion);
  });
  actions.appendChild(cancel);

  const submit = h('button', { class: 'btn-primary', id: 'btn-follow-up-submit' }, '↳ Send follow-up');
  submit.addEventListener('click', () => {
    const question = textarea.value.trim();
    if (!question) {
      toast('Type a follow-up question first.', 'err');
      return;
    }
    if (selectedSet.size === 0) {
      toast('Pick at least one member to answer.', 'err');
      return;
    }
    let targetType = 'all';
    let payload = { question };
    if (selectedSet.size === candidates.length) {
      targetType = 'all';
    } else if (selectedSet.size === 1) {
      targetType = 'specific';
      payload.selectedMemberId = [...selectedSet][0];
    } else {
      targetType = 'subset';
      payload.selectedMemberIds = [...selectedSet];
    }
    payload.targetType = targetType;
    triggerFollowUp(discussion, payload);
  });
  actions.appendChild(submit);
  wrap.appendChild(actions);

  return wrap;
}

async function triggerFollowUp(discussion, payload) {
  setActionButtonsBusy(true);
  state.followUpComposerOpen = false;
  try {
    // Show the user's follow-up as a bubble + a fresh round divider
    const targetLabel =
      payload.targetType === 'specific'
        ? 'Follow-up · targeted'
        : payload.targetType === 'subset'
          ? 'Follow-up · subset'
          : 'Follow-up';
    appendToStream(userBubble(payload.question, targetLabel));
    const nextRound = (discussion.rounds[discussion.rounds.length - 1]?.roundNumber ?? 0) + 1;
    appendToStream(roundDivider(nextRound));
    await fetchJSON(`/api/discussions/${discussion.id}/follow-up`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    toast('Follow-up dispatched — board is responding…', 'ok');
    // Replace the composer footer with a busy footer until WS lands the result
    const footer = $('#chat-footer');
    if (footer) {
      footer.replaceWith(h('div', { class: 'chat-footer', id: 'chat-footer' }, h('div', { class: 'message-meta' }, '… orchestrator deciding')));
    }
  } catch (e) {
    toast('Follow-up failed: ' + e.message, 'err');
    setActionButtonsBusy(false);
    state.followUpComposerOpen = true;
    refreshChatFooter(discussion);
  }
}

function appendToStream(node) {
  const stream = $('#chat-stream');
  if (stream) {
    stream.appendChild(node);
    scrollChat();
  }
}

function renderRespondForm(discussion) {
  const req = discussion.pendingUserRequest;
  const wrap = h('div', { class: 'respond-form' });

  wrap.appendChild(h('div', { class: 'struct-section-title' }, 'Your reply'));

  let selectedOption = null;
  if (req.options?.length) {
    const opts = h('div', { class: 'respond-options' });
    req.options.forEach((opt, idx) => {
      const chip = h('button', { class: 'chip respond-option', type: 'button' }, `${idx + 1}. ${opt}`);
      chip.addEventListener('click', () => {
        selectedOption = opt;
        $$('.respond-option', opts).forEach((c) => c.classList.remove('selected'));
        chip.classList.add('selected');
      });
      opts.appendChild(chip);
    });
    wrap.appendChild(opts);
  }

  const textarea = h('textarea', {
    id: 'respond-input',
    rows: '3',
    placeholder: req.options?.length
      ? 'Pick an option above and/or write your answer…'
      : 'Type your answer to the board…',
  });
  wrap.appendChild(textarea);

  const submit = h('button', { class: 'btn-primary', id: 'btn-respond' }, '↳ Send reply');
  submit.addEventListener('click', () => {
    const content = textarea.value.trim();
    if (!content && !selectedOption) {
      toast('Type a reply or pick an option first.', 'err');
      return;
    }
    const finalContent = content || selectedOption || '';
    triggerRespond(discussion, finalContent, selectedOption);
  });
  wrap.appendChild(submit);
  return wrap;
}

async function triggerContinue(discussion) {
  setActionButtonsBusy(true);
  try {
    addSystemLine('Continuing the discussion…');
    await fetchJSON(`/api/discussions/${discussion.id}/continue`, { method: 'POST' });
    toast('Continuing — orchestrator deciding…', 'ok');
  } catch (e) {
    toast('Continue failed: ' + e.message, 'err');
    setActionButtonsBusy(false);
  }
}

async function triggerRespond(discussion, content, selectedOption) {
  setActionButtonsBusy(true);
  try {
    // Show the user's reply as a bubble immediately, plus a fresh round divider
    appendToStream(userBubble(content, 'Your reply', selectedOption));
    const nextRound = (discussion.rounds[discussion.rounds.length - 1]?.roundNumber ?? 0) + 1;
    appendToStream(roundDivider(nextRound));
    await fetchJSON(`/api/discussions/${discussion.id}/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content, selectedOption: selectedOption || undefined }),
    });
    toast('Reply sent — board is responding…', 'ok');
  } catch (e) {
    toast('Reply failed: ' + e.message, 'err');
    setActionButtonsBusy(false);
  }
}

function setActionButtonsBusy(busy) {
  const btns = [$('#btn-continue'), $('#btn-respond')].filter(Boolean);
  for (const b of btns) {
    b.disabled = busy;
    if (busy && b.id === 'btn-continue') b.textContent = '… working';
    if (busy && b.id === 'btn-respond') b.textContent = '… sending';
  }
}

function truncatePreview(s, n) {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n) + '…';
}

function startNewChatView(question, members) {
  state.pendingTyping.clear();
  const main = $('#main');
  main.innerHTML = '';
  const view = h('div', { class: 'view chat-view' });

  const header = h('div', { class: 'view-header' });
  const back = h('button', { class: 'btn-secondary' }, '← Back');
  back.addEventListener('click', () => navigate('discussions'));
  header.appendChild(back);
  header.appendChild(h('div', { class: 'chat-header-q' }, question));
  header.appendChild(h('div', {}, ''));
  view.appendChild(header);

  const stream = h('div', { class: 'chat-stream', id: 'chat-stream' });
  // User's question as the first bubble — like sending a message in a chat app
  stream.appendChild(userBubble(question, 'Question'));
  stream.appendChild(roundDivider(1));
  view.appendChild(stream);

  // Placeholder footer — will be replaced by refreshChatFooter() when the
  // discussion lands via WS `discussion_completed` or `discussion_gated`.
  view.appendChild(h('div', { class: 'chat-footer', id: 'chat-footer' }));

  main.appendChild(view);
}

// User message bubble — right-aligned, like sent messages in iMessage/WhatsApp.
function userBubble(text, label, selectedOption) {
  const wrap = h('div', { class: 'message message-user' });

  const body = h('div', { class: 'message-body user-body' });
  const name = h('div', { class: 'message-name' }, label || 'You');
  body.appendChild(name);

  const bubble = h('div', { class: 'bubble user-bubble' }, text);
  body.appendChild(bubble);

  if (selectedOption) {
    body.appendChild(h('div', { class: 'message-meta', style: 'margin-top:4px' }, `↳ chose: ${selectedOption}`));
  }

  wrap.appendChild(body);
  // Avatar on the right (mirrored from member layout)
  wrap.appendChild(h('div', { class: 'avatar avatar-user', 'data-color': 'brand' }, '👤'));
  return wrap;
}

function roundDivider(n) {
  return h('div', { class: 'round-divider' }, `Round ${n}`);
}

function messageBubble(r) {
  const member = state.members.find((m) => m.id === r.memberId) || { name: r.memberName };
  const color = member.color || colorForMember(r.memberName);
  const initials = member.initials || initialsOf(r.memberName);

  const wrap = h('div', { class: 'message' });
  wrap.appendChild(h('div', { class: 'avatar', 'data-color': color }, initials));

  const body = h('div', { class: 'message-body' });
  const name = h('div', { class: 'message-name' }, r.memberName);
  if (r.turnNumber) {
    name.appendChild(h('span', { class: 'message-meta' }, `turn ${r.turnNumber}`));
  }
  body.appendChild(name);

  const bubble = h('div', { class: 'bubble' }, r.content);
  body.appendChild(bubble);

  // Structured details
  const sd = r.structuredData;
  if (sd && (sd.keyPoints?.length || sd.questionsForOthers?.length || sd.actionSteps?.length || sd.confidence != null)) {
    const struct = h('div', { class: 'struct' });
    if (sd.keyPoints?.length) struct.appendChild(structSection('Key points', sd.keyPoints, '•'));
    if (sd.questionsForOthers?.length) struct.appendChild(structSection('Questions for others', sd.questionsForOthers, '?'));
    if (sd.actionSteps?.length) struct.appendChild(structSection('Action steps', sd.actionSteps, '→'));
    if (typeof sd.confidence === 'number') {
      const row = h('div', { class: 'confidence-row' });
      row.appendChild(h('span', {}, `Confidence ${sd.confidence}%`));
      const bar = h('div', { class: 'confidence-bar' });
      bar.appendChild(h('div', { class: 'confidence-bar-fill', style: `width: ${sd.confidence}%` }));
      row.appendChild(bar);
      struct.appendChild(row);
    }
    body.appendChild(struct);
  }

  wrap.appendChild(body);
  return wrap;
}

function structSection(title, items, marker) {
  const sec = h('div', { class: 'struct-section' });
  sec.appendChild(h('div', { class: 'struct-section-title' }, title));
  const ul = h('ul');
  items.forEach((it) => ul.appendChild(h('li', {}, `${marker ? marker + ' ' : ''}${it}`)));
  sec.appendChild(ul);
  return sec;
}

function typingBubble(memberName) {
  const member = state.members.find((m) => m.name === memberName) || { name: memberName };
  const color = member.color || colorForMember(memberName);
  const initials = member.initials || initialsOf(memberName);

  const wrap = h('div', { class: 'message', 'data-typing-for': memberName });
  wrap.appendChild(h('div', { class: 'avatar', 'data-color': color }, initials));

  const body = h('div', { class: 'message-body' });
  body.appendChild(h('div', { class: 'message-name' }, memberName));

  // Inline activity label + animated dots — both inside the bubble shape so
  // the shape doesn't shift when the label changes.
  const bubble = h('div', { class: 'typing-bubble' });
  const activityLabel = h(
    'span',
    { class: 'typing-activity', 'data-activity-for': memberName },
    'thinking',
  );
  bubble.appendChild(activityLabel);
  const dots = h('div', { class: 'typing' });
  dots.appendChild(h('span'));
  dots.appendChild(h('span'));
  dots.appendChild(h('span'));
  bubble.appendChild(dots);
  body.appendChild(bubble);

  // Optional secondary line (e.g. the search query, the file path)
  body.appendChild(h('div', { class: 'typing-detail', 'data-detail-for': memberName }));

  wrap.appendChild(body);
  return wrap;
}

function updateTypingActivity(memberName, activity, detail) {
  const label = document.querySelector(`[data-activity-for="${cssEscape(memberName)}"]`);
  if (label) label.textContent = (activity || 'thinking').replace(/[.…]+$/, '');
  const detailEl = document.querySelector(`[data-detail-for="${cssEscape(memberName)}"]`);
  if (detailEl) {
    if (detail) {
      const truncated = String(detail).length > 80 ? String(detail).slice(0, 80) + '…' : String(detail);
      detailEl.textContent = truncated;
      detailEl.style.display = 'block';
    } else {
      detailEl.textContent = '';
      detailEl.style.display = 'none';
    }
  }
}

function cssEscape(s) {
  // Minimal CSS attribute-value escape for double-quote selectors.
  return String(s).replace(/(["\\])/g, '\\$1');
}

function orchestratorBubble(decision) {
  const text = decisionLabel(decision);
  return h('div', { class: 'message' }, [
    h('div', { class: 'avatar', 'data-color': 'purple' }, '⚙'),
    h('div', { class: 'message-body' }, [
      h('div', { class: 'message-name' }, ['Orchestrator', h('span', { class: 'message-meta' }, `confidence ${decision.confidence ?? '–'}%`)]),
      h('div', { class: 'system-bubble' }, text),
    ]),
  ]);
}

function pendingRequestBubble(req) {
  const lines = [
    h('div', { class: 'message-name' }, '⚠ The board is asking you a question'),
    h('div', { class: 'bubble' }, [
      h('strong', {}, req.question),
      ...(req.context ? [h('div', { class: 'message-meta', style: 'display:block;margin-top:6px' }, req.context)] : []),
      ...(req.options?.length
        ? [
            h('div', { style: 'margin-top: 10px' }, [
              h('div', { class: 'struct-section-title' }, 'Options'),
              h(
                'ol',
                { style: 'padding-left: 22px; margin: 0' },
                req.options.map((o) => h('li', {}, o)),
              ),
            ]),
          ]
        : []),
    ]),
  ];
  return h('div', { class: 'message' }, [h('div', { class: 'avatar', 'data-color': 'yellow' }, '!'), h('div', { class: 'message-body' }, lines)]);
}

function decisionLabel(d) {
  const action = (d.action || 'continue').toUpperCase();
  return `${action}${d.reasoning ? ' — ' + d.reasoning : ''}`;
}

function addTypingBubble(memberName) {
  const stream = $('#chat-stream');
  if (!stream) return;
  const existing = state.pendingTyping.get(memberName);
  if (existing) return; // already showing
  const bubble = typingBubble(memberName);
  stream.appendChild(bubble);
  state.pendingTyping.set(memberName, bubble);
  scrollChat();
}

function replaceTypingWithResponse(memberName, response) {
  const stream = $('#chat-stream');
  if (!stream) return;
  // Primary: state.pendingTyping (Map keyed by name). Fallback: DOM search
  // by data-typing-for attribute (in case the Map ever drifts out of sync —
  // belt and suspenders).
  let typing = memberName ? state.pendingTyping.get(memberName) : null;
  if (!typing && memberName) {
    typing = stream.querySelector(`[data-typing-for="${cssEscape(memberName)}"]`);
  }
  const bubble = messageBubble(response);
  if (typing) {
    typing.replaceWith(bubble);
    if (memberName) state.pendingTyping.delete(memberName);
  } else {
    stream.appendChild(bubble);
  }
  scrollChat();
}

function addSystemLine(text) {
  const stream = $('#chat-stream');
  if (!stream) return;
  stream.appendChild(
    h('div', { class: 'message' }, [
      h('div', { class: 'avatar', 'data-color': 'purple' }, '⚙'),
      h('div', { class: 'message-body' }, [h('div', { class: 'system-bubble' }, text)]),
    ]),
  );
  scrollChat();
}

function addOrchestratorDecision(decision) {
  const stream = $('#chat-stream');
  if (!stream) return;
  // Remove the "analyzing" system line if present
  const lastSys = $$('.system-bubble', stream).pop();
  if (lastSys && lastSys.textContent.includes('analyzing')) {
    lastSys.closest('.message')?.remove();
  }
  stream.appendChild(orchestratorBubble(decision));
  scrollChat();
}

function finalizeChat(msg, opts = {}) {
  // Any typing bubbles that never got a matching member_response (e.g., a
  // member failed silently) become orphans — clear them so the user isn't
  // staring at perpetually-thinking dots.
  state.pendingTyping.forEach((bubble, name) => {
    bubble.replaceWith(
      h('div', { class: 'message' }, [
        h('div', { class: 'avatar', 'data-color': 'red' }, '✗'),
        h('div', { class: 'message-body' }, [
          h('div', { class: 'message-name' }, name),
          h('div', { class: 'system-bubble' }, 'No response — this member failed or timed out.'),
        ]),
      ]),
    );
  });
  state.pendingTyping.clear();

  // Re-fetch the bootstrap state so the discussion list refreshes
  fetchJSON('/api/state').then((data) => {
    state.discussions = data.discussions;
  });
  const stream = $('#chat-stream');
  if (stream && !opts.gated) {
    const cost = msg.costUsd != null ? `$${Number(msg.costUsd).toFixed(4)}` : '$0.00';
    const dur = msg.durationMs ? formatDuration(msg.durationMs) : '';
    stream.appendChild(
      h(
        'div',
        { class: 'message' },
        [
          h('div', { class: 'avatar', 'data-color': 'green' }, '✓'),
          h('div', { class: 'message-body' }, [h('div', { class: 'system-bubble' }, `Round saved · ${dur} · ${cost}`)]),
        ],
      ),
    );
    scrollChat();
  }
  if (msg.discussion?.pendingUserRequest && stream) {
    stream.appendChild(pendingRequestBubble(msg.discussion.pendingUserRequest));
    scrollChat();
  }
  // Refresh the action footer so Continue / Respond / concluded state matches
  // the current discussion — the engine may have just changed any of them.
  if (msg.discussion) {
    refreshChatFooter(msg.discussion);
  }
  setActionButtonsBusy(false);
}

function refreshChatFooter(discussion) {
  const oldFooter = $('#chat-footer');
  if (!oldFooter) return;
  oldFooter.replaceWith(renderChatFooter(discussion));
}

function scrollChat() {
  requestAnimationFrame(() => {
    const stream = $('#chat-stream');
    if (stream) stream.scrollTop = stream.scrollHeight;
  });
}

function updateDiscussionList(discussion) {
  const idx = state.discussions.findIndex((d) => d.id === discussion.id);
  if (idx >= 0) state.discussions[idx] = discussion;
  else state.discussions.unshift(discussion);
}

// ------------------------------------------------------------------
// New-discussion modal
// ------------------------------------------------------------------

function setupModal() {
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal-cancel').addEventListener('click', closeModal);
  $('#modal-submit').addEventListener('click', submitNewDiscussion);
}

async function openNewDiscussionModal() {
  // Always refresh members from server first — protects against stale state
  // if the user just edited members in another tab.
  await refreshState({ silent: true });
  renderWorkspaceCard();

  const modal = $('#new-discussion-modal');
  modal.hidden = false;
  $('#new-question').value = '';

  const chips = $('#member-chips');
  chips.innerHTML = '';
  const submit = $('#modal-submit');
  const active = (state.members || []).filter((m) => m.isActive);

  if (active.length === 0) {
    submit.disabled = true;
    const wsRoot = state.workspace?.root || '<unknown>';
    const wsId = state.workspace?.id || '<unknown>';
    chips.appendChild(
      h('div', { class: 'modal-empty' }, [
        h('div', { class: 'modal-empty-title' }, '⚠ No active members in this workspace'),
        h('div', { class: 'modal-empty-meta' }, `Workspace: ${wsId}`),
        h('div', { class: 'modal-empty-meta', style: 'font-family: var(--font-mono); font-size:11px' }, wsRoot),
        h('div', { class: 'modal-empty-meta', style: 'margin-top:8px' },
          'Either this is the wrong workspace, or no members were seeded. Click "Board members" in the sidebar to add one, or run `aab init` from this directory.'),
      ]),
    );
    $('#new-question').focus();
    return;
  }

  submit.disabled = false;
  for (const m of active) {
    const chip = h('div', { class: 'chip selected', 'data-member-id': m.id });
    chip.appendChild(h('div', { class: 'avatar', 'data-color': m.color || colorForMember(m.name) }, m.initials || initialsOf(m.name)));
    chip.appendChild(h('span', {}, m.name));
    chip.addEventListener('click', () => chip.classList.toggle('selected'));
    chips.appendChild(chip);
  }
  $('#new-question').focus();
}

function closeModal() {
  $('#new-discussion-modal').hidden = true;
}

async function submitNewDiscussion() {
  const question = $('#new-question').value.trim();
  if (!question) {
    toast('Please enter a question.', 'err');
    return;
  }
  const memberIds = $$('#member-chips .chip.selected').map((c) => c.dataset.memberId);
  if (memberIds.length === 0) {
    toast('Select at least one member.', 'err');
    return;
  }

  const submit = $('#modal-submit');
  submit.disabled = true;
  submit.textContent = 'Starting…';

  // Open the chat view BEFORE the request so #chat-stream exists by the time
  // any `member_thinking` events arrive over WS. Pre-create the typing
  // bubbles too so the user sees activity immediately, not a blank stream.
  closeModal();
  const selectedMembers = state.members.filter((m) => memberIds.includes(m.id));
  startNewChatView(question, selectedMembers);
  for (const m of selectedMembers) addTypingBubble(m.name);

  try {
    await fetchJSON('/api/discussions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question, memberIds }),
    });
    toast('Discussion started — members are thinking…', 'ok');
  } catch (e) {
    toast('Failed to start: ' + e.message, 'err');
    // Server rejected — clear the optimistic typing bubbles
    state.pendingTyping.forEach((b) => b.remove());
    state.pendingTyping.clear();
    appendToStream(
      h('div', { class: 'message' }, [
        h('div', { class: 'avatar', 'data-color': 'red' }, '✗'),
        h('div', { class: 'message-body' }, [
          h('div', { class: 'system-bubble' }, 'Could not start the discussion: ' + e.message),
        ]),
      ]),
    );
  } finally {
    submit.disabled = false;
    submit.textContent = 'Start discussion';
  }
}

// ------------------------------------------------------------------
// Members view
// ------------------------------------------------------------------

function renderMembersView(main) {
  const view = h('div', { class: 'view' });
  const activeCount = state.members.filter((m) => m.isActive).length;
  const header = h('div', { class: 'view-header' }, [
    h('div', {}, [
      h('div', { class: 'view-title' }, 'Board members'),
      h('div', { class: 'view-subtitle' }, `${activeCount} active · ${state.members.length} total`),
    ]),
  ]);
  const addBtn = h('button', { class: 'btn-primary' }, '+ Add member');
  addBtn.addEventListener('click', () => openMemberEditModal(null));
  header.appendChild(addBtn);
  view.appendChild(header);

  const body = h('div', { class: 'view-body' });
  if (state.members.length === 0) {
    const empty = emptyState(
      '👥',
      'No members in this workspace',
      `Add one now, or run \`aab init\` to seed Elon, Julian, and Alexandra.`,
    );
    const seedBtn = h('button', { class: 'btn-primary', style: 'margin-top:12px' }, '+ Add a member');
    seedBtn.addEventListener('click', () => openMemberEditModal(null));
    empty.appendChild(seedBtn);
    body.appendChild(empty);
  } else {
    const grid = h('div', { class: 'members-grid' });
    for (const m of state.members) grid.appendChild(memberCard(m));
    body.appendChild(grid);
  }
  view.appendChild(body);
  main.appendChild(view);
}

function memberCard(m) {
  const card = h('div', { class: 'member-card' + (m.isActive ? '' : ' is-inactive') });

  const head = h('div', { class: 'member-card-head' });
  head.appendChild(h('div', { class: 'avatar', 'data-color': m.color || colorForMember(m.name) }, m.initials || initialsOf(m.name)));
  head.appendChild(
    h('div', { class: 'member-card-headtext' }, [
      h('div', { class: 'member-card-name' }, m.name),
      h('div', { class: 'member-card-title' }, m.title),
    ]),
  );
  // Active toggle (top-right of card)
  const toggle = h(
    'label',
    { class: 'switch', title: m.isActive ? 'Deactivate' : 'Activate' },
    [
      h('input', { type: 'checkbox' }),
      h('span', { class: 'switch-track' }),
    ],
  );
  const checkbox = toggle.querySelector('input');
  checkbox.checked = !!m.isActive;
  checkbox.addEventListener('change', async () => {
    try {
      await fetchJSON(`/api/members/${m.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ isActive: checkbox.checked }),
      });
      m.isActive = checkbox.checked;
      // Refresh the card class without re-rendering everything
      card.classList.toggle('is-inactive', !m.isActive);
      renderWorkspaceCard();
      toast(`${m.name} ${m.isActive ? 'activated' : 'deactivated'}.`, 'ok');
    } catch (e) {
      checkbox.checked = !checkbox.checked;
      toast('Could not update: ' + e.message, 'err');
    }
  });
  head.appendChild(toggle);
  card.appendChild(head);

  const exp = h('div', { class: 'expertise' });
  (m.expertise || []).forEach((e) => exp.appendChild(h('span', { class: 'expertise-tag' }, e)));
  card.appendChild(exp);

  card.appendChild(h('div', { class: 'persona-preview' }, m.persona));

  // Action buttons row
  const actions = h('div', { class: 'card-actions' });
  const editBtn = h('button', { class: 'btn-secondary' }, 'Edit');
  editBtn.addEventListener('click', () => openMemberEditModal(m));
  const delBtn = h('button', { class: 'btn-danger-ghost' }, 'Delete');
  delBtn.addEventListener('click', () =>
    openConfirmModal({
      title: `Delete ${m.name}?`,
      message: `This removes the member, their .claude/agents/${m.slug || initialsOf(m.name)}.md file (if AAB-generated), and they won't appear in future discussions.`,
      okLabel: 'Delete',
      onOk: async () => {
        try {
          await fetchJSON(`/api/members/${m.id}`, { method: 'DELETE' });
          await refreshState({ silent: true });
          renderWorkspaceCard();
          navigate('members');
          toast(`${m.name} deleted.`, 'ok');
        } catch (e) {
          toast('Could not delete: ' + e.message, 'err');
        }
      },
    }),
  );
  actions.appendChild(editBtn);
  actions.appendChild(delBtn);
  card.appendChild(actions);

  return card;
}

// ------------------------------------------------------------------
// Actions (kanban) view
// ------------------------------------------------------------------

function renderActionsView(main) {
  const view = h('div', { class: 'view' });
  view.appendChild(
    h('div', { class: 'view-header' }, [
      h('div', {}, [
        h('div', { class: 'view-title' }, 'Action Board'),
        h('div', { class: 'view-subtitle' }, `${state.actionItems.length} action item${state.actionItems.length === 1 ? '' : 's'}`),
      ]),
    ]),
  );
  const body = h('div', { class: 'view-body' });

  if (state.actionItems.length === 0) {
    body.appendChild(
      emptyState(
        '📋',
        'No action items yet',
        'Action items show up here when a discussion produces them. Editing comes in Phase 4.',
      ),
    );
  } else {
    const board = h('div', { class: 'kanban' });
    for (const status of ['pending', 'in-progress', 'completed']) {
      const items = state.actionItems.filter((a) => a.status === status);
      const col = h('div', { class: 'kanban-col' });
      col.appendChild(
        h('div', { class: 'kanban-col-head' }, [
          h('span', {}, status),
          h('span', { class: 'kanban-col-count' }, String(items.length)),
        ]),
      );
      const cards = h('div', { class: 'kanban-cards' });
      for (const a of items) cards.appendChild(actionCard(a));
      col.appendChild(cards);
      board.appendChild(col);
    }
    body.appendChild(board);
  }

  view.appendChild(body);
  main.appendChild(view);
}

function actionCard(a) {
  const card = h('div', { class: 'kanban-card' });
  card.appendChild(h('div', { class: 'kanban-card-title' }, a.title));
  const meta = h('div', { class: 'kanban-card-meta' });
  meta.appendChild(h('span', { class: 'priority-mark ' + a.priority }));
  meta.appendChild(h('span', {}, a.priority));
  if (a.dueDate) meta.appendChild(h('span', {}, '· due ' + a.dueDate.slice(0, 10)));
  card.appendChild(meta);
  if (a.linkedSkill) {
    card.appendChild(h('div', { class: 'message-meta' }, `🧠 skill: ${a.linkedSkill.name}`));
  }
  return card;
}

// ------------------------------------------------------------------
// Principles view
// ------------------------------------------------------------------

function renderPrinciplesView(main) {
  const view = h('div', { class: 'view' });
  const activeCount = state.principles.filter((p) => p.isActive).length;
  const header = h('div', { class: 'view-header' }, [
    h('div', {}, [
      h('div', { class: 'view-title' }, 'Principles'),
      h(
        'div',
        { class: 'view-subtitle' },
        `${activeCount} active · ${state.principles.length} total`,
      ),
    ]),
  ]);
  const addBtn = h('button', { class: 'btn-primary' }, '+ Add principle');
  addBtn.addEventListener('click', () => openPrincipleEditModal(null));
  header.appendChild(addBtn);
  view.appendChild(header);

  const body = h('div', { class: 'view-body' });
  if (state.principles.length === 0) {
    const empty = emptyState(
      '🧭',
      'No principles yet',
      'Add one, or run `aab init` to seed Dalio-inspired starters.',
    );
    const seedBtn = h('button', { class: 'btn-primary', style: 'margin-top:12px' }, '+ Add a principle');
    seedBtn.addEventListener('click', () => openPrincipleEditModal(null));
    empty.appendChild(seedBtn);
    body.appendChild(empty);
  } else {
    const grid = h('div', { class: 'principles-grid' });
    for (const p of state.principles) grid.appendChild(principleCard(p));
    body.appendChild(grid);
  }
  view.appendChild(body);
  main.appendChild(view);
}

function principleCard(p) {
  const card = h('div', { class: 'principle-card' + (p.isActive ? '' : ' is-inactive') });
  const head = h('div', { class: 'principle-head' }, [
    h('div', { class: 'principle-title' }, p.title),
    h('div', { class: 'principle-cat' }, p.category),
  ]);
  // Switch
  const toggle = h('label', { class: 'switch' });
  const cb = h('input', { type: 'checkbox' });
  cb.checked = !!p.isActive;
  cb.addEventListener('click', (ev) => ev.stopPropagation());
  cb.addEventListener('change', async () => {
    try {
      await fetchJSON(`/api/principles/${p.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ isActive: cb.checked }),
      });
      p.isActive = cb.checked;
      card.classList.toggle('is-inactive', !p.isActive);
      toast(`Principle ${p.isActive ? 'activated' : 'deactivated'}.`, 'ok');
    } catch (e) {
      cb.checked = !cb.checked;
      toast('Could not update: ' + e.message, 'err');
    }
  });
  toggle.appendChild(cb);
  toggle.appendChild(h('span', { class: 'switch-track' }));
  head.appendChild(toggle);
  card.appendChild(head);

  card.appendChild(h('div', { class: 'principle-desc' }, p.description));
  const row = h('div', { class: 'priority-row' });
  row.appendChild(h('span', {}, `priority ${p.priority}/10`));
  const bar = h('div', { class: 'priority-bar' });
  bar.appendChild(h('div', { class: 'priority-bar-fill', style: `width: ${p.priority * 10}%` }));
  row.appendChild(bar);
  card.appendChild(row);

  card.addEventListener('click', () => openPrincipleEditModal(p));
  card.style.cursor = 'pointer';
  return card;
}

// ------------------------------------------------------------------
// Settings view
// ------------------------------------------------------------------

function renderSettingsView(main) {
  const view = h('div', { class: 'view' });
  view.appendChild(
    h('div', { class: 'view-header' }, [
      h('div', {}, [
        h('div', { class: 'view-title' }, 'Settings'),
        h('div', { class: 'view-subtitle' }, 'Workspace-level configuration'),
      ]),
    ]),
  );
  const body = h('div', { class: 'view-body' });
  const form = h('div', { class: 'settings-form' });

  const s = state.settings || {};

  const fieldDefs = [
    { key: 'boardTitle', label: 'Board title', type: 'text', help: 'Shown at the top of the dashboard.' },
    { key: 'maxMembersPerDiscussion', label: 'Max members per discussion', type: 'number', min: 1, max: 12 },
    { key: 'maxTurnsPerDiscussion', label: 'Max turns per discussion', type: 'number', min: 2, max: 30, help: 'When totalTurns hits this, the discussion auto-concludes.' },
    {
      key: 'orchestratorPromptStyle',
      label: 'Orchestrator style',
      type: 'select',
      options: ['analytical', 'creative', 'balanced'],
    },
    { key: 'autoSummarization', label: 'Auto-summarize on conclude', type: 'switch' },
    { key: 'consensusThreshold', label: 'Consensus threshold (%)', type: 'number', min: 0, max: 100 },
    { key: 'enableUserInteraction', label: 'Enable HITL (orchestrator can ask you questions)', type: 'switch' },
    {
      key: 'primaryModel',
      label: 'Primary model (members)',
      type: 'select',
      options: ['inherit', 'opus', 'sonnet', 'haiku', 'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-haiku-4-5-20251001'],
    },
    {
      key: 'researchModel',
      label: 'Research model (skill task research, sparring)',
      type: 'select',
      options: ['inherit', 'opus', 'sonnet', 'haiku', 'claude-opus-4-7', 'claude-sonnet-4-6'],
    },
    {
      key: 'fastModel',
      label: 'Fast model (orchestrator)',
      type: 'select',
      options: ['inherit', 'opus', 'sonnet', 'haiku', 'claude-haiku-4-5-20251001'],
    },
    { key: 'perCallBudgetUsd', label: 'Per-call budget (USD)', type: 'number', step: '0.5', min: 0, help: 'Passed to claude --max-budget-usd.' },
    { key: 'locale', label: 'Locale', type: 'text' },
  ];

  const inputs = {};
  for (const f of fieldDefs) {
    const wrap = h('div', { class: 'form-field' });
    wrap.appendChild(h('label', { class: 'field-label' }, f.label));
    if (f.type === 'switch') {
      const lbl = h('label', { class: 'switch' });
      const cb = h('input', { type: 'checkbox' });
      cb.checked = !!s[f.key];
      lbl.appendChild(cb);
      lbl.appendChild(h('span', { class: 'switch-track' }));
      wrap.appendChild(lbl);
      inputs[f.key] = cb;
    } else if (f.type === 'select') {
      const sel = h('select');
      for (const opt of f.options) {
        const o = h('option', { value: opt }, opt);
        if (s[f.key] === opt) o.selected = true;
        sel.appendChild(o);
      }
      wrap.appendChild(sel);
      inputs[f.key] = sel;
    } else {
      const attrs = { type: f.type };
      if (f.min != null) attrs.min = String(f.min);
      if (f.max != null) attrs.max = String(f.max);
      if (f.step) attrs.step = f.step;
      const inp = h('input', attrs);
      inp.value = s[f.key] != null ? String(s[f.key]) : '';
      wrap.appendChild(inp);
      inputs[f.key] = inp;
    }
    if (f.help) wrap.appendChild(h('div', { class: 'field-help' }, f.help));
    form.appendChild(wrap);
  }

  const actions = h('div', { class: 'form-actions' });
  const saveBtn = h('button', { class: 'btn-primary' }, 'Save settings');
  const resetBtn = h('button', { class: 'btn-secondary' }, 'Reset form');
  resetBtn.addEventListener('click', () => navigate('settings'));
  saveBtn.addEventListener('click', async () => {
    const payload = {};
    for (const f of fieldDefs) {
      const inp = inputs[f.key];
      if (f.type === 'switch') payload[f.key] = inp.checked;
      else if (f.type === 'number') {
        const v = inp.value;
        if (v === '' || v == null) continue;
        payload[f.key] = Number(v);
      } else {
        payload[f.key] = inp.value;
      }
    }
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      const updated = await fetchJSON('/api/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      state.settings = updated;
      toast('Settings saved.', 'ok');
    } catch (e) {
      toast('Save failed: ' + e.message, 'err');
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save settings';
    }
  });
  actions.appendChild(saveBtn);
  actions.appendChild(resetBtn);
  form.appendChild(actions);

  body.appendChild(form);
  view.appendChild(body);
  main.appendChild(view);
}

// ------------------------------------------------------------------
// Edit modal (members + principles share this)
// ------------------------------------------------------------------

let editModalOnSave = null;
let editModalOnDelete = null;

function setupEditModal() {
  $('#edit-modal-close').addEventListener('click', closeEditModal);
  $('#edit-modal-cancel').addEventListener('click', closeEditModal);
  $('#edit-modal-save').addEventListener('click', async () => {
    if (!editModalOnSave) return;
    const btn = $('#edit-modal-save');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      await editModalOnSave();
      closeEditModal();
    } catch (e) {
      toast('Save failed: ' + e.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save';
    }
  });
  $('#edit-modal-delete').addEventListener('click', () => {
    if (editModalOnDelete) editModalOnDelete();
  });
}

function closeEditModal() {
  $('#edit-modal').hidden = true;
  $('#edit-modal-body').innerHTML = '';
  editModalOnSave = null;
  editModalOnDelete = null;
  $('#edit-modal-delete').hidden = true;
}

function openMemberEditModal(member) {
  const isNew = !member;
  $('#edit-modal-title').textContent = isNew ? 'Add board member' : `Edit ${member.name}`;
  const body = $('#edit-modal-body');
  body.innerHTML = '';

  const fields = {
    name: input('Name', member?.name || '', 'e.g. Sam Altman'),
    title: input('Title', member?.title || '', 'e.g. CEO, OpenAI'),
    expertise: input(
      'Expertise (comma-separated)',
      (member?.expertise || []).join(', '),
      'e.g. AI strategy, scaling, product',
    ),
    persona: textarea(
      'Persona (1-2 paragraphs)',
      member?.persona || '',
      "How they think, what they're known for. Used in the agent's system prompt.",
      6,
    ),
    voiceGuide: textarea(
      'Voice guide (optional)',
      member?.voiceGuide || '',
      'Style, vocabulary, characteristic phrases. Helps the LLM sound like them.',
      3,
    ),
  };
  for (const [k, frag] of Object.entries(fields)) body.appendChild(frag.wrap);

  if (!isNew) {
    body.appendChild(
      h('label', { class: 'switch-row' }, [
        h('span', {}, 'Active'),
        (() => {
          const lbl = h('label', { class: 'switch' });
          const cb = h('input', { type: 'checkbox' });
          cb.checked = !!member.isActive;
          lbl.appendChild(cb);
          lbl.appendChild(h('span', { class: 'switch-track' }));
          fields.isActive = { input: cb };
          return lbl;
        })(),
      ]),
    );
    $('#edit-modal-delete').hidden = false;
    editModalOnDelete = () =>
      openConfirmModal({
        title: `Delete ${member.name}?`,
        message: 'This will also remove the corresponding agent file if it was AAB-generated.',
        okLabel: 'Delete',
        onOk: async () => {
          try {
            await fetchJSON(`/api/members/${member.id}`, { method: 'DELETE' });
            await refreshState({ silent: true });
            renderWorkspaceCard();
            closeEditModal();
            navigate('members');
            toast(`${member.name} deleted.`, 'ok');
          } catch (e) {
            toast('Could not delete: ' + e.message, 'err');
          }
        },
      });
  }

  $('#edit-modal').hidden = false;
  fields.name.input.focus();

  editModalOnSave = async () => {
    const name = fields.name.input.value.trim();
    if (!name) {
      toast('Name is required.', 'err');
      throw new Error('Name is required.');
    }
    const payload = {
      name,
      title: fields.title.input.value.trim(),
      expertise: fields.expertise.input.value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      persona: fields.persona.input.value.trim(),
      voiceGuide: fields.voiceGuide.input.value.trim() || undefined,
    };
    if (!isNew) payload.isActive = fields.isActive.input.checked;

    if (isNew) {
      await fetchJSON('/api/members', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      toast(`${name} added.`, 'ok');
    } else {
      await fetchJSON(`/api/members/${member.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      toast(`${name} updated.`, 'ok');
    }
    await refreshState({ silent: true });
    renderWorkspaceCard();
    if (state.route === 'members') navigate('members');
  };
}

function openPrincipleEditModal(principle) {
  const isNew = !principle;
  $('#edit-modal-title').textContent = isNew ? 'Add principle' : `Edit ${principle.title}`;
  const body = $('#edit-modal-body');
  body.innerHTML = '';

  const fields = {
    title: input('Title', principle?.title || '', 'e.g. Embrace Radical Truth'),
    description: textarea(
      'Description',
      principle?.description || '',
      'What this principle means in plain language.',
      4,
    ),
    behavior: textarea(
      'Behavior (when applied well)',
      principle?.behavior || '',
      'What it looks like in action.',
      3,
    ),
    category: select(
      'Category',
      ['life', 'work', 'relationships', 'health', 'finance', 'meta'],
      principle?.category || 'meta',
    ),
    priority: input('Priority (1-10)', String(principle?.priority ?? 5), '5', 'number'),
  };
  for (const frag of Object.values(fields)) body.appendChild(frag.wrap);

  if (!isNew) {
    body.appendChild(
      h('label', { class: 'switch-row' }, [
        h('span', {}, 'Active'),
        (() => {
          const lbl = h('label', { class: 'switch' });
          const cb = h('input', { type: 'checkbox' });
          cb.checked = !!principle.isActive;
          lbl.appendChild(cb);
          lbl.appendChild(h('span', { class: 'switch-track' }));
          fields.isActive = { input: cb };
          return lbl;
        })(),
      ]),
    );
    $('#edit-modal-delete').hidden = false;
    editModalOnDelete = () =>
      openConfirmModal({
        title: `Delete "${principle.title}"?`,
        message: 'This removes the principle from the workspace.',
        okLabel: 'Delete',
        onOk: async () => {
          try {
            await fetchJSON(`/api/principles/${principle.id}`, { method: 'DELETE' });
            await refreshState({ silent: true });
            closeEditModal();
            navigate('principles');
            toast(`Principle deleted.`, 'ok');
          } catch (e) {
            toast('Could not delete: ' + e.message, 'err');
          }
        },
      });
  }

  $('#edit-modal').hidden = false;
  fields.title.input.focus();

  editModalOnSave = async () => {
    const title = fields.title.input.value.trim();
    if (!title) {
      toast('Title is required.', 'err');
      throw new Error('Title is required.');
    }
    const payload = {
      title,
      description: fields.description.input.value.trim(),
      behavior: fields.behavior.input.value.trim(),
      category: fields.category.input.value,
      priority: Number(fields.priority.input.value) || 5,
    };
    if (!isNew) payload.isActive = fields.isActive.input.checked;

    if (isNew) {
      await fetchJSON('/api/principles', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      toast(`"${title}" added.`, 'ok');
    } else {
      await fetchJSON(`/api/principles/${principle.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      toast(`"${title}" updated.`, 'ok');
    }
    await refreshState({ silent: true });
    if (state.route === 'principles') navigate('principles');
  };
}

// Form-field helpers used by edit modals
function input(label, value, placeholder, type = 'text') {
  const wrap = h('div', { class: 'form-field' });
  wrap.appendChild(h('label', { class: 'field-label' }, label));
  const inp = h('input', { type, placeholder: placeholder || '' });
  inp.value = value || '';
  wrap.appendChild(inp);
  return { wrap, input: inp };
}

function textarea(label, value, placeholder, rows = 3) {
  const wrap = h('div', { class: 'form-field' });
  wrap.appendChild(h('label', { class: 'field-label' }, label));
  const ta = h('textarea', { rows: String(rows), placeholder: placeholder || '' });
  ta.value = value || '';
  wrap.appendChild(ta);
  return { wrap, input: ta };
}

function select(label, options, value) {
  const wrap = h('div', { class: 'form-field' });
  wrap.appendChild(h('label', { class: 'field-label' }, label));
  const sel = h('select');
  for (const opt of options) {
    const o = h('option', { value: opt }, opt);
    if (opt === value) o.selected = true;
    sel.appendChild(o);
  }
  wrap.appendChild(sel);
  return { wrap, input: sel };
}

// ------------------------------------------------------------------
// Confirm modal
// ------------------------------------------------------------------

let confirmOnOk = null;

function setupConfirmModal() {
  $('#confirm-modal-close').addEventListener('click', closeConfirmModal);
  $('#confirm-modal-cancel').addEventListener('click', closeConfirmModal);
  $('#confirm-modal-ok').addEventListener('click', async () => {
    const ok = $('#confirm-modal-ok');
    ok.disabled = true;
    try {
      if (confirmOnOk) await confirmOnOk();
    } finally {
      ok.disabled = false;
      closeConfirmModal();
    }
  });
}

function openConfirmModal({ title, message, okLabel = 'Confirm', onOk }) {
  $('#confirm-modal-title').textContent = title || 'Are you sure?';
  $('#confirm-modal-message').textContent = message || '';
  $('#confirm-modal-ok').textContent = okLabel;
  confirmOnOk = onOk || null;
  $('#confirm-modal').hidden = false;
}

function closeConfirmModal() {
  $('#confirm-modal').hidden = true;
  confirmOnOk = null;
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'style') el.setAttribute('style', v);
    else el.setAttribute(k, v);
  }
  if (typeof children === 'string') {
    el.textContent = children;
  } else if (Array.isArray(children)) {
    children.forEach((c) => {
      if (c == null) return;
      if (typeof c === 'string') el.appendChild(document.createTextNode(c));
      else el.appendChild(c);
    });
  } else if (children) {
    el.appendChild(children);
  }
  return el;
}

function emptyState(emoji, title, subtitle) {
  return h('div', { class: 'empty-state' }, [
    h('div', { class: 'empty-state-emoji' }, emoji),
    h('div', { class: 'empty-state-title' }, title),
    h('div', {}, subtitle),
  ]);
}

function initialsOf(name) {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function formatRelative(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.round(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return iso.slice(0, 10);
}

function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return `${m}m ${r}s`;
}

async function fetchJSON(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const data = await res.json();
      if (data?.error) msg = data.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  return res.json();
}

function toast(message, kind = '') {
  const t = h('div', { class: `toast ${kind}` }, message);
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 4500);
}

// ------------------------------------------------------------------
// Go
// ------------------------------------------------------------------

bootstrap();
