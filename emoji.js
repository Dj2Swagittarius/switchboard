// Emoji picker for message composers. Include with <script src="/emoji.js">;
// exposes window.switchboardEmoji.open(anchorEl, onPick).
//
// A popover with category tabs, search by name, and recently used (kept in
// localStorage). The emoji list is built in, so nothing is fetched. Picked
// emoji are handed to onPick(char); the caller inserts them.
(() => {
  // "char name;char name;…" per category. Names drive search.
  const CATS = [
    ['recent', 'Recently used', '🕘', ''],
    ['smileys', 'Smileys & People', '😀', '😀 grinning;😃 smiley;😄 smile;😁 grin;😆 laughing;😅 sweat smile;🤣 rofl rolling laughing;😂 joy tears laughing;🙂 slight smile;🙃 upside down;😉 wink;😊 blush happy;😇 innocent halo;🥰 love hearts;😍 heart eyes;🤩 star struck;😘 kiss;😗 kissing;😚 kissing closed eyes;😙 kissing smiling;😋 yum;😛 tongue;😜 wink tongue;🤪 zany crazy;😝 squint tongue;🤑 money;🤗 hug;🤭 hand over mouth;🤫 shush quiet;🤔 thinking;🤐 zipper mouth;🤨 raised eyebrow;😐 neutral;😑 expressionless;😶 no mouth;😏 smirk;😒 unamused;🙄 eye roll;😬 grimace;🤥 lying;😌 relieved;😔 pensive;😪 sleepy;🤤 drool;😴 sleeping;😷 mask sick;🤒 thermometer sick;🤕 bandage hurt;🤢 nauseated;🤮 vomit;🤧 sneeze;🥵 hot;🥶 cold;🥴 woozy;😵 dizzy;🤯 mind blown;🤠 cowboy;🥳 party;😎 cool sunglasses;🤓 nerd;🧐 monocle;😕 confused;😟 worried;🙁 frown;☹️ frowning;😮 open mouth;😯 hushed;😲 astonished;😳 flushed;🥺 pleading;😦 frowning open;😧 anguished;😨 fearful;😰 anxious sweat;😥 sad relieved;😢 cry;😭 sob;😱 scream;😖 confounded;😣 persevere;😞 disappointed;😓 sweat;😩 weary;😫 tired;🥱 yawn;😤 triumph huff;😡 pout angry;😠 angry;🤬 cursing;😈 smiling devil;👿 imp;💀 skull;💩 poop;🤡 clown;👻 ghost;👽 alien;🤖 robot;👋 wave hi bye;🤚 raised back hand;✋ raised hand stop;🖐️ hand fingers;👌 ok;✌️ victory peace;🤞 crossed fingers luck;🤟 love you;🤘 rock on;🤙 call me;👈 point left;👉 point right;👆 point up;👇 point down;☝️ index up;👍 thumbs up yes like;👎 thumbs down no;✊ fist;👊 punch;👏 clap;🙌 raised hands;👐 open hands;🤲 palms up;🤝 handshake deal;🙏 pray thanks please;✍️ writing;💪 muscle strong;👀 eyes look;👁️ eye;👂 ear;👃 nose;🧠 brain;👶 baby;🧒 child;👦 boy;👧 girl;🧑 person;👨 man;👩 woman;🧓 older person;👴 old man;👵 old woman;🙋 raising hand;🙇 bow;🤦 facepalm;🤷 shrug;👷 construction worker;👨‍🔧 mechanic technician;👩‍💻 technologist;👨‍💼 office worker;🕵️ detective;💂 guard;👩‍🚒 firefighter;👮 police;👩‍⚕️ health worker;🏃 running;🚶 walking;💃 dancing;🕺 man dancing;👪 family;💑 couple;❤️ red heart love;🧡 orange heart;💛 yellow heart;💚 green heart;💙 blue heart;💜 purple heart;🖤 black heart;🤍 white heart;💔 broken heart;💕 two hearts;💯 hundred;💢 anger;💥 collision boom;💫 dizzy star;💦 sweat droplets;💨 dash;💬 speech;💭 thought;💤 zzz sleep'],
    ['animals', 'Animals & Nature', '🐶', '🐶 dog;🐱 cat;🐭 mouse;🐹 hamster;🐰 rabbit;🦊 fox;🐻 bear;🐼 panda;🐨 koala;🐯 tiger;🦁 lion;🐮 cow;🐷 pig;🐸 frog;🐵 monkey;🙈 see no evil;🙉 hear no evil;🙊 speak no evil;🐔 chicken;🐧 penguin;🐦 bird;🐤 chick;🦆 duck;🦅 eagle;🦉 owl;🦇 bat;🐺 wolf;🐗 boar;🐴 horse;🦄 unicorn;🐝 bee;🐛 bug;🦋 butterfly;🐌 snail;🐞 ladybug;🐜 ant;🕷️ spider;🦂 scorpion;🐢 turtle;🐍 snake;🦎 lizard;🐙 octopus;🦑 squid;🦀 crab;🐠 fish;🐬 dolphin;🐳 whale;🦈 shark;🐊 crocodile;🐘 elephant;🦒 giraffe;🐕 dog;🐈 cat;🌵 cactus;🎄 christmas tree;🌲 evergreen;🌳 tree;🌴 palm;🌱 seedling;🌿 herb;☘️ shamrock;🍀 four leaf clover luck;🍁 maple leaf;🍂 fallen leaves;🌷 tulip;🌹 rose;🌺 hibiscus;🌸 cherry blossom;🌼 blossom;🌻 sunflower;🌞 sun face;🌝 full moon face;🌙 crescent moon;⭐ star;🌟 glowing star;✨ sparkles;⚡ lightning;🔥 fire lit;🌈 rainbow;☀️ sun;⛅ partly cloudy;☁️ cloud;🌧️ rain;⛈️ storm;❄️ snowflake;☃️ snowman;🌊 wave water;💧 droplet'],
    ['food', 'Food & Drink', '🍎', '🍏 green apple;🍎 apple;🍐 pear;🍊 orange;🍋 lemon;🍌 banana;🍉 watermelon;🍇 grapes;🍓 strawberry;🍒 cherries;🍑 peach;🥭 mango;🍍 pineapple;🥥 coconut;🥝 kiwi;🍅 tomato;🥑 avocado;🥦 broccoli;🥕 carrot;🌽 corn;🌶️ hot pepper;🥔 potato;🍞 bread;🥐 croissant;🥯 bagel;🧀 cheese;🥚 egg;🍳 cooking;🥓 bacon;🥩 steak;🍗 poultry leg;🍖 meat;🌭 hot dog;🍔 hamburger burger;🍟 fries;🍕 pizza;🥪 sandwich;🌮 taco;🌯 burrito;🥗 salad;🍝 spaghetti;🍜 ramen noodles;🍲 stew;🍛 curry;🍣 sushi;🍱 bento;🍤 shrimp;🍚 rice;🍦 ice cream;🍩 doughnut donut;🍪 cookie;🎂 birthday cake;🍰 cake;🧁 cupcake;🍫 chocolate;🍬 candy;🍭 lollipop;🍯 honey;☕ coffee;🍵 tea;🥤 soda cup;🧃 juice box;🍺 beer;🍻 cheers beers;🥂 champagne toast;🍷 wine;🥃 whiskey;🍸 cocktail;🍹 tropical drink;🍾 bottle popping;🧊 ice;🍴 fork knife;🥄 spoon'],
    ['activities', 'Activities', '⚽', '⚽ soccer;🏀 basketball;🏈 football;⚾ baseball;🥎 softball;🎾 tennis;🏐 volleyball;🏉 rugby;🎱 pool 8 ball;🏓 ping pong;🏸 badminton;🏒 hockey;⛳ golf;🏹 archery;🎣 fishing;🥊 boxing;🥋 martial arts;⛸️ ice skate;🎿 ski;🛷 sled;🏂 snowboard;🏋️ weight lifting;🤸 cartwheel;🏊 swimming;🚴 biking;🏆 trophy;🥇 gold medal first;🥈 silver medal;🥉 bronze medal;🏅 medal;🎖️ military medal;🎗️ ribbon;🎫 ticket;🎟️ admission tickets;🎪 circus;🎭 theater;🎨 art palette;🎬 movie clapper;🎤 microphone;🎧 headphones;🎼 music score;🎹 piano;🥁 drum;🎷 saxophone;🎺 trumpet;🎸 guitar;🎻 violin;🎲 dice;🎯 bullseye target;🎳 bowling;🎮 video game;🧩 puzzle;🎉 party popper tada;🎊 confetti;🎈 balloon;🎁 gift present'],
    ['travel', 'Travel & Places', '🚗', '🚗 car;🚕 taxi;🚙 suv;🚌 bus;🏎️ race car;🚓 police car;🚑 ambulance;🚒 fire engine;🚐 van;🚚 truck delivery;🚛 semi truck;🚜 tractor;🛵 scooter;🏍️ motorcycle;🚲 bicycle;🛴 kick scooter;🚨 siren;🚔 police;🚍 bus;🚘 car;🚖 taxi;✈️ airplane;🛫 departure;🛬 arrival;🚀 rocket;🚁 helicopter;⛵ sailboat;🚤 speedboat;🛳️ ship;⚓ anchor;⛽ fuel gas;🚧 construction;🚦 traffic light;🗺️ map;🧭 compass;🏔️ mountain snow;⛰️ mountain;🏕️ camping;🏖️ beach;🏝️ island;🏠 house home;🏡 house garden;🏢 office building;🏣 post office;🏥 hospital;🏦 bank;🏨 hotel;🏪 store;🏫 school;🏭 factory;🏗️ construction site;🏘️ houses;⛪ church;🗽 statue of liberty;🌆 city dusk;🌃 night city;🌉 bridge;🎡 ferris wheel;🎢 roller coaster;📍 pin location;🗓️ calendar'],
    ['objects', 'Objects', '💡', '⌚ watch;📱 phone mobile;📲 phone call arrow;💻 laptop;⌨️ keyboard;🖥️ desktop computer;🖨️ printer;🖱️ mouse;💽 disk;💾 floppy save;📷 camera;📸 camera flash;📹 video camera;📞 telephone receiver;☎️ telephone;📟 pager;📠 fax;📺 tv;📻 radio;🔋 battery;🔌 plug;💡 bulb idea;🔦 flashlight;🕯️ candle;💸 money wings;💵 dollar;💳 credit card;💰 money bag;🧾 receipt;🔧 wrench tool;🔨 hammer;🛠️ tools;⚙️ gear;🔩 nut bolt;🧰 toolbox;🧱 brick;🔒 lock;🔓 unlocked;🔑 key;🚪 door;🪑 chair;🛏️ bed;🚿 shower;🛁 bathtub;🧹 broom;🧺 basket;🧻 toilet paper;🧼 soap;📦 package box;📫 mailbox;📮 postbox;✉️ envelope;📧 email;📨 incoming envelope;📝 memo note;📄 page;📃 page curl;📑 bookmark tabs;📊 bar chart;📈 chart up;📉 chart down;📋 clipboard;📅 calendar date;📆 tear-off calendar;📁 folder;📂 open folder;📌 pushpin;📎 paperclip;✂️ scissors;🖊️ pen;✏️ pencil;🔍 magnifying glass search;🔗 link;💊 pill;🩹 bandage;🩺 stethoscope;🧯 fire extinguisher;⏰ alarm clock;⏳ hourglass;🔔 bell;🔕 no bell;📣 megaphone;📢 loudspeaker'],
    ['symbols', 'Symbols', '✅', '✅ check mark done;☑️ ballot check;✔️ check;❌ cross no;❎ cross mark button;➕ plus;➖ minus;➗ divide;✖️ multiply;❓ question;❔ white question;❕ white exclamation;❗ exclamation;‼️ double exclamation;⁉️ interrobang;⚠️ warning;🚫 prohibited;⛔ no entry;🔴 red circle;🟠 orange circle;🟡 yellow circle;🟢 green circle;🔵 blue circle;🟣 purple circle;⚫ black circle;⚪ white circle;🟥 red square;🟩 green square;🟦 blue square;⬛ black square;⬜ white square;🔺 red triangle up;🔻 red triangle down;🔸 small orange diamond;🔹 small blue diamond;➡️ right arrow;⬅️ left arrow;⬆️ up arrow;⬇️ down arrow;↩️ return arrow;🔄 counterclockwise refresh;🔁 repeat;🔂 repeat one;▶️ play;⏸️ pause;⏹️ stop;⏺️ record;⏩ fast forward;⏪ rewind;🔀 shuffle;🆗 ok button;🆕 new;🆓 free;🆘 sos help;🆙 up;🆒 cool;🔝 top;🔜 soon;🔚 end;🔛 on;♻️ recycle;✳️ asterisk;❇️ sparkle;©️ copyright;®️ registered;™️ trademark;#️⃣ hash;*️⃣ asterisk key;0️⃣ zero;1️⃣ one;2️⃣ two;3️⃣ three;4️⃣ four;5️⃣ five;6️⃣ six;7️⃣ seven;8️⃣ eight;9️⃣ nine;🔟 ten;💲 dollar sign;🔅 dim;🔆 bright;📶 signal bars;📳 vibration;📴 phone off;🔇 mute;🔈 speaker;🔉 speaker medium;🔊 loud speaker;🎵 music note;🎶 notes;⏏️ eject;🕐 one oclock;🕒 three oclock;🕕 six oclock;🕘 nine oclock;♥️ heart suit;♠️ spade;♣️ club;♦️ diamond'],
    ['flags', 'Flags', '🏁', '🏁 checkered flag finish;🚩 red flag;🎌 crossed flags;🏴 black flag;🏳️ white flag;🏳️‍🌈 rainbow flag;🇺🇸 united states usa;🇨🇦 canada;🇲🇽 mexico;🇬🇧 united kingdom uk;🇮🇪 ireland;🇫🇷 france;🇩🇪 germany;🇮🇹 italy;🇪🇸 spain;🇵🇹 portugal;🇳🇱 netherlands;🇧🇪 belgium;🇨🇭 switzerland;🇸🇪 sweden;🇳🇴 norway;🇩🇰 denmark;🇫🇮 finland;🇵🇱 poland;🇺🇦 ukraine;🇬🇷 greece;🇹🇷 turkey;🇮🇱 israel;🇮🇳 india;🇵🇰 pakistan;🇨🇳 china;🇯🇵 japan;🇰🇷 south korea;🇵🇭 philippines;🇻🇳 vietnam;🇹🇭 thailand;🇦🇺 australia;🇳🇿 new zealand;🇧🇷 brazil;🇦🇷 argentina;🇨🇴 colombia;🇵🇪 peru;🇨🇱 chile;🇻🇪 venezuela;🇨🇺 cuba;🇯🇲 jamaica;🇩🇴 dominican republic;🇵🇷 puerto rico;🇭🇹 haiti;🇳🇬 nigeria;🇿🇦 south africa;🇪🇬 egypt;🇰🇪 kenya'],
  ];
  const DATA = CATS.map(([id, label, icon, list]) => ({
    id, label, icon,
    items: list ? list.split(';').map((s) => { const i = s.indexOf(' '); return { c: s.slice(0, i), n: s.slice(i + 1) }; }) : [],
  }));
  const ALL = DATA.flatMap((d) => d.items);

  const RECENT_KEY = 'emojiRecent', RECENT_MAX = 24;
  const recent = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; } };
  const remember = (c) => {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify([c, ...recent().filter((x) => x !== c)].slice(0, RECENT_MAX))); } catch {}
  };

  const css = `
  .ep{position:fixed;z-index:1200;width:336px;max-width:calc(100vw - 16px);height:380px;display:flex;flex-direction:column;
    background:var(--panel,#171b21);color:var(--ink,#e6e9ee);border:1px solid var(--line,#252b33);border-radius:14px;
    box-shadow:var(--shadow,0 18px 50px rgba(0,0,0,.45));font:14px/1.4 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    -webkit-backdrop-filter:blur(var(--blur,22px)) saturate(var(--sat,1.4));backdrop-filter:blur(var(--blur,22px)) saturate(var(--sat,1.4))}
  .ep[hidden]{display:none}
  .ep-tabs{display:flex;gap:2px;padding:6px 8px 0;border-bottom:1px solid var(--line,#252b33)}
  .ep-tab{flex:1;border:0;background:transparent !important;box-shadow:none;padding:6px 0 7px;font-size:17px;cursor:pointer;border-bottom:2px solid transparent;
    border-radius:6px 6px 0 0;filter:grayscale(.6);opacity:.8}
  .ep-tab:hover{background:var(--hover,var(--bg,#0f1216)) !important}
  .ep-tab[aria-selected=true]{border-bottom-color:var(--accent,#5b8dff);filter:none;opacity:1}
  .ep-search{margin:8px 10px 4px;padding:7px 10px;border-radius:9px;border:1px solid var(--line,#252b33);
    background:var(--bg,#0f1216);color:inherit;font:inherit}
  .ep-search:focus{outline:2px solid var(--accent,#5b8dff);outline-offset:-1px;border-color:transparent}
  .ep-body{flex:1;overflow:auto;padding:2px 8px 8px}
  .ep-h{font-size:12px;font-weight:650;color:var(--muted,#8b95a1);padding:8px 4px 4px}
  .ep-grid{display:grid;grid-template-columns:repeat(8,1fr);gap:2px}
  .ep-e{border:0;background:transparent !important;box-shadow:none;font-size:23px;line-height:1;padding:5px 0;border-radius:8px;cursor:pointer;
    font-family:"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif}
  .ep-e:hover,.ep-e:focus-visible{background:var(--hover,var(--bg,#0f1216)) !important;outline:none}
  .ep-empty{color:var(--muted,#8b95a1);padding:18px 6px;text-align:center;font-size:13px}
  .ep-foot{display:flex;align-items:center;gap:10px;padding:6px 12px;border-top:1px solid var(--line,#252b33);min-height:40px}
  .ep-big{font-size:24px;font-family:"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif}
  .ep-name{color:var(--muted,#8b95a1);font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}`;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  let box = null, onPick = null, anchor = null, tab = 'smileys';

  function build() {
    box = el('div', 'ep');
    box.hidden = true;
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Emoji');
    const tabs = el('div', 'ep-tabs');
    tabs.setAttribute('role', 'tablist');
    for (const d of DATA) {
      const t = el('button', 'ep-tab', d.icon);
      t.type = 'button'; t.title = d.label; t.dataset.cat = d.id;
      t.setAttribute('role', 'tab'); t.setAttribute('aria-label', d.label);
      t.onclick = () => { tab = d.id; search.value = ''; render(); };
      tabs.appendChild(t);
    }
    const search = el('input', 'ep-search');
    search.type = 'search'; search.placeholder = 'Search'; search.setAttribute('aria-label', 'Search emoji');
    search.oninput = render;
    search.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); const first = body.querySelector('.ep-e'); if (first) first.click(); }
      if (e.key === 'Escape') close();
    };
    const body = el('div', 'ep-body');
    const foot = el('div', 'ep-foot');
    const big = el('span', 'ep-big', '😀'), name = el('span', 'ep-name', 'Pick an emoji…');
    foot.append(big, name);
    box.append(tabs, search, body, foot);
    document.body.appendChild(box);
    box._parts = { tabs, search, body, big, name };
  }

  function grid(items) {
    const g = el('div', 'ep-grid');
    const { big, name } = box._parts;
    for (const it of items) {
      const b = el('button', 'ep-e', it.c);
      b.type = 'button'; b.title = it.n; b.setAttribute('aria-label', it.n);
      b.onmouseenter = b.onfocus = () => { big.textContent = it.c; name.textContent = it.n; };
      b.onclick = () => { remember(it.c); const f = onPick; if (f) f(it.c); };
      g.appendChild(b);
    }
    return g;
  }

  function render() {
    const { tabs, search, body } = box._parts;
    body.textContent = '';
    const q = search.value.trim().toLowerCase();
    for (const t of tabs.children) t.setAttribute('aria-selected', String(!q && t.dataset.cat === tab));
    if (q) {
      const hits = ALL.filter((it) => it.n.includes(q)).slice(0, 120);
      body.appendChild(el('div', 'ep-h', 'Results'));
      body.appendChild(hits.length ? grid(hits) : el('div', 'ep-empty', 'No emoji match that.'));
      return;
    }
    const d = DATA.find((x) => x.id === tab);
    body.appendChild(el('div', 'ep-h', d.label));
    const items = d.id === 'recent' ? recent().map((c) => ALL.find((it) => it.c === c) || { c, n: '' }) : d.items;
    body.appendChild(items.length ? grid(items) : el('div', 'ep-empty', 'Emoji you use show up here.'));
    body.scrollTop = 0;
  }

  function place() {
    const r = anchor.getBoundingClientRect();
    const w = box.offsetWidth || 336, h = box.offsetHeight || 380;
    let left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
    let top = r.top - h - 8;                         // above the button, like the composer's own layout
    if (top < 8) top = Math.min(window.innerHeight - h - 8, r.bottom + 8);
    box.style.left = left + 'px'; box.style.top = Math.max(8, top) + 'px';
  }

  const outside = (e) => { if (box && !box.hidden && !box.contains(e.target) && e.target !== anchor && !anchor?.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape' && box && !box.hidden) { e.preventDefault(); close(); } };
  function close() {
    if (!box || box.hidden) return;
    box.hidden = true;
    document.removeEventListener('mousedown', outside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', close);
    anchor?.setAttribute('aria-expanded', 'false');
  }

  function open(anchorEl, pick) {
    if (!box) build();
    if (!box.hidden && anchor === anchorEl) { close(); return; }   // the button toggles
    anchor = anchorEl; onPick = pick;
    tab = recent().length ? 'recent' : 'smileys';
    box._parts.search.value = '';
    box.hidden = false;
    render();
    place();
    anchor.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', close);
    setTimeout(() => box._parts.search.focus(), 0);
  }

  window.switchboardEmoji = { open, close };
})();
