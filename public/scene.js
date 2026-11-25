// Pixel-art office floor. Everything is drawn with rectangles on a small canvas that CSS scales up.

export const WIDTH = 400;
export const HEIGHT = 250;
const CORRIDOR = 126;

export const SEATS = {
  owner: { x: 64, y: 62 },
  manager: { x: 190, y: 62 },
  pm: { x: 320, y: 62 },
  senior: { x: 110, y: 186 },
  junior: { x: 210, y: 186 },
  qa: { x: 310, y: 186 },
  reviewer: { x: 256, y: 62 }, // the hot desk: the contractor is only there while reviewing
};
const VISITORS = ['reviewer'];
const ENTRANCE = { x: WIDTH + 8, y: CORRIDOR }; // visitors come and go off the right edge of the floor

const LOOKS = {
  owner: { shirt: '#2b2d3a', hair: '#3a2a1e', skin: '#e8b98f', accent: '#e0b040' },
  manager: { shirt: '#7b4bb3', hair: '#1e1a22', skin: '#c98d62' },
  senior: { shirt: '#2f6fd0', hair: '#8a8f99', skin: '#e8b98f' },
  junior: { shirt: '#2fa36b', hair: '#c8642a', skin: '#f1c9a5' },
  qa: { shirt: '#d07a2f', hair: '#2a1c14', skin: '#8d5a3b' },
  pm: { shirt: '#c93f6b', hair: '#e6c15a', skin: '#e8b98f' },
  reviewer: { shirt: '#5b6470', hair: '#5a3d2b', skin: '#d9a57c' },
};

// The kitchen sits under the owner's office wall, bottom-left of the floor.
const COFFEE_SPOT = { x: 30, y: 146 };
const KITCHEN_DOOR = { x: 86, y: 146 };

// Places the dog likes. Each has a clear straight line up to the dog's lane.
const DOG_LANE = 140;
const DOG_BED = { x: 363, y: 226 };
// The stand-up table, and where each person stands around it.
const MEETING = { x: 373, y: 166 };
const MEETING_SPOTS = {
  manager: { x: 373, y: 148 },
  senior: { x: 354, y: 160 },
  qa: { x: 354, y: 178 },
  pm: { x: 392, y: 160 },
  junior: { x: 392, y: 178 },
};
const DOG_SPOTS = [
  { x: 150, y: 140 }, { x: 250, y: 138 }, { x: 336, y: 150 }, { x: 160, y: 234 },
  { x: 260, y: 234 }, { x: 94, y: 98 }, { x: 58, y: 154 }, { x: 238, y: 100 },
];

const standSpot = (id) => ({ x: SEATS[id].x + 28, y: SEATS[id].y + 8 });
const between = (low, high) => low + Math.random() * (high - low);
const pick = (list) => list[Math.floor(Math.random() * list.length)];

export function createScene(canvas) {
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const context = canvas.getContext('2d');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let agents = {};
  let board = null;
  let confetti = [];
  const walkers = new Map(); // id -> { x, y, points, pauseUntil, mug }
  const hotMugUntil = {}; // id -> time the desk mug stops steaming
  let brewingUntil = 0;
  let fridgeOpenUntil = 0;
  let nextCoffeeAt = performance.now() + 15000;
  const makePet = (kind, x, y, state) => ({
    kind, x, y, state, points: [], then: 'sit', stay: 0, until: performance.now() + 5000, facing: -1, lovedUntil: 0,
  });
  const dog = makePet('dog', DOG_BED.x, DOG_BED.y, 'sleep');
  const claude = makePet('claude', 238, 100, 'sit'); // the office's pet Claude spark
  const pets = [dog, claude];
  // The dog's ball. Click it to throw it; the dog runs after it.
  const BALL_FLIGHT = 900;
  // Where a throw can land: open floor, clear of the desks and of the name tags, which would take the click.
  const BALL_SPOTS = [
    { x: 150, y: 148 }, { x: 250, y: 148 }, { x: 336, y: 150 }, { x: 170, y: 170 }, { x: 262, y: 168 },
    { x: 60, y: 156 }, { x: 100, y: 102 }, { x: 300, y: 120 }, { x: 388, y: 122 }, { x: 386, y: 238 },
  ];
  const ball = { x: 386, y: 238, fromX: 386, fromY: 238, thrownAt: -BALL_FLIGHT };

  const box = (x, y, width, height, colour) => {
    context.fillStyle = colour;
    context.fillRect(Math.round(x), Math.round(y), width, height);
  };

  /** Two or three pixels of steam drifting up from (x, y). */
  function steam(x, y, frame) {
    const phase = frame % 4;
    box(x + (phase % 2), y - 2 - phase, 1, 2, '#ffffff');
    box(x + 2 - (phase % 2), y - 5 - ((phase + 2) % 4), 1, 2, '#f1f4f8');
  }

  function drawRoom(time, frame) {
    // floor
    box(0, 0, WIDTH, HEIGHT, '#d6c39c');
    for (let y = 26; y < HEIGHT; y += 16) {
      for (let x = (y / 16) % 2 ? 0 : 16; x < WIDTH; x += 32) box(x, y, 16, 16, '#cdb98f');
    }
    // back wall
    box(0, 0, WIDTH, 26, '#53648a');
    box(0, 22, WIDTH, 4, '#3b4767');
    // windows
    // windows show the real time of day: night, dawn or dusk, or daylight
    const clock = new Date();
    const hour = clock.getHours() + clock.getMinutes() / 60;
    const night = hour < 6 || hour >= 20;
    const golden = !night && (hour < 8 || hour >= 17.5);
    for (const x of [150, 226]) {
      box(x, 5, 30, 14, '#2c3855');
      box(x + 1, 6, 28, 12, night ? '#141a36' : golden ? '#f2a65a' : '#9fd0ea');
      if (night) {
        for (const [starX, starY] of [[4, 8], [10, 15], [20, 9], [25, 14], [17, 12]]) box(x + starX, starY, 1, 1, '#fdfbe6');
        if (x === 226) box(x + 21, 7, 4, 4, '#f4f1d0'); // moon
      } else if (golden) {
        box(x + 1, 13, 28, 5, '#f7c98b');
        box(x + 6, 11, 5, 5, '#fff1b8'); // low sun
      } else {
        box(x + 3, 8, 6, 2, '#d9eef8'); // cloud
        box(x + 19, 12, 7, 2, '#d9eef8');
      }
      box(x + 14, 6, 2, 12, '#2c3855');
    }
    // board behind the project manager: one stack of notes per column, taller for more tickets
    box(284, 3, 72, 18, '#f3f1ea');
    box(284, 3, 72, 2, '#8a8f99');
    const columns = board?.columns?.slice(0, 6) || [];
    const most = Math.max(1, ...columns.map((column) => column.count));
    const palette = ['#4c9aff', '#f5c518', '#b07cf0', '#ff8f6b', '#36b37e', '#8a8f99'];
    const slot = 66 / Math.max(columns.length, 1);
    columns.forEach((column, index) => {
      const stack = column.count ? Math.max(1, Math.round((column.count / most) * 3)) : 0;
      for (let note = 0; note < stack; note += 1) {
        box(287 + index * slot, 16 - note * 4, Math.max(4, Math.floor(slot) - 3), 3, palette[index]);
      }
    });
    // owner's office: rug, side wall, front wall with a doorway
    box(14, 34, 104, 78, '#9c4b4b');
    box(18, 38, 96, 70, '#b05c57');
    box(126, 22, 4, 96, '#3b4767');
    box(0, 114, 84, 4, '#3b4767');
    box(104, 114, 26, 4, '#3b4767');
    box(10, 6, 22, 13, '#e8dcc0'); // framed picture
    box(12, 8, 18, 9, '#6fa37a');

    // kitchen: tiled floor, counter with coffee machine, sink and mugs, fridge
    for (let y = 118; y < 170; y += 8) {
      for (let x = 0; x < 80; x += 8) box(x, y, 8, 8, (x + y) % 16 ? '#7fa9ad' : '#6c989d');
    }
    box(4, 118, 56, 12, '#f1ece2'); // counter top
    box(4, 130, 56, 5, '#8c6a48');
    box(4, 135, 56, 1, '#6d5035');
    box(8, 119, 12, 10, '#aeb6bf'); // sink
    box(10, 121, 8, 6, '#7f8a95');
    box(13, 118, 2, 3, '#5d6670');
    box(24, 116, 13, 13, '#2a2d36'); // coffee machine
    box(26, 118, 9, 4, '#454a57');
    box(28, 124, 5, 4, '#15171d');
    box(34, 119, 1, 1, time < brewingUntil ? '#ff5a4d' : '#58d68d');
    if (time < brewingUntil) steam(29, 117, frame);
    for (const x of [42, 47, 52]) box(x, 122, 4, 4, '#ffffff'); // clean mugs
    box(61, 109, 16, 26, '#4a525e'); // fridge, outlined so it stands out
    box(62, 110, 14, 24, '#eef1f4');
    box(62, 118, 14, 1, '#b9c0c8');
    box(73, 112, 1, 4, '#8d939e');
    if (time < fridgeOpenUntil) {
      box(62, 119, 14, 15, '#fff3c4'); // lit inside
      box(62, 126, 14, 1, '#d9c98a'); // shelf
      box(64, 121, 3, 5, '#ffffff'); // milk
      box(64, 121, 3, 1, '#3b6fb0');
      box(69, 128, 4, 3, '#7fbf6a');
      box(77, 118, 3, 17, '#dfe4ea'); // door swung open
      box(77, 118, 3, 1, '#4a525e');
    } else {
      box(73, 121, 1, 8, '#8d939e');
    }

    // plants
    for (const [x, y] of [[140, 36], [382, 36], [16, 228], [382, 208]]) {
      box(x - 4, y, 8, 7, '#8a5a34');
      box(x - 6, y - 9, 12, 9, '#3f8f4f');
      box(x - 3, y - 13, 6, 5, '#55ab63');
    }
    // water cooler
    box(360, 40, 12, 16, '#e6e9ee');
    box(362, 30, 8, 11, '#8fc7ea');
    box(364, 47, 3, 2, '#3b6fb0');
    // dog bed and bowl
    box(351, 219, 24, 11, '#5f73ad');
    box(353, 221, 20, 7, '#8fa3d6');
    box(336, 226, 7, 3, '#c0392b');
    box(337, 226, 5, 1, '#7a5a3a');
  }

  /** A monitor seen from behind, on a stand. (x, y) is its top-left corner. */
  function drawMonitor(x, y) {
    box(x, y, 12, 8, '#2b2f3a');
    box(x, y, 12, 1, '#3d4352');
    box(x + 5, y + 3, 2, 2, '#6b7385');
    box(x + 10, y + 6, 1, 1, '#58d68d');
    box(x + 5, y + 8, 2, 3, '#1f232c');
    box(x + 3, y + 11, 6, 1, '#1f232c');
  }

  function drawDesk(id, seat, working, time, frame) {
    const half = id === 'owner' ? 22 : 18;
    box(seat.x - half, seat.y + 5, half * 2, 11, '#a5743f');
    box(seat.x - half, seat.y + 16, half * 2, 6, '#70492a');
    box(seat.x - half, seat.y + 22, 3, 5, '#5a3a20');
    box(seat.x + half - 3, seat.y + 22, 3, 5, '#5a3a20');
    if (id === 'owner') {
      // Your two extra monitors, one either side of the laptop.
      drawMonitor(seat.x - 21, seat.y - 4);
      drawMonitor(seat.x + 9, seat.y - 4);
    }
    // laptop seen from behind
    // The lid turns red while this task's latest test run is failing, and shows a green light once it passes.
    const mood = agents[id]?.mood;
    box(seat.x - 6, seat.y + 2, 12, 8, mood === 'failing' ? (frame % 2 ? '#e0574c' : '#c9473d') : '#c5cad3');
    box(seat.x - 6, seat.y + 10, 12, 1, '#8d939e');
    const light = mood === 'passing' ? '#3fcf7a' : mood === 'failing' ? '#ffd9d4' : working && frame % 2 ? '#fff6b0' : '#8d939e';
    box(seat.x - 1, seat.y + 5, 2, 2, light);
    // mug, steaming for a while after a coffee run
    box(seat.x + half - 9, seat.y + 8, 4, 4, '#f3f1ea');
    if (time < (hotMugUntil[id] || 0)) steam(seat.x + half - 8, seat.y + 8, frame);
  }

  function drawPerson(x, y, look, { walking = false, standing = false, typing = false, frame = 0, alert = false, mug = false } = {}) {
    const bob = !walking && !standing && !typing && frame % 8 === 0 ? 1 : 0;
    const top = y - 10 + bob;
    if (walking || standing) {
      // Legs show whenever someone is away from their desk; they only alternate while moving.
      box(x - 3, y + 6, 2, walking && frame % 2 ? 5 : 4, '#2a2d3a');
      box(x + 1, y + 6, 2, walking && frame % 2 ? 4 : 5, '#2a2d3a');
    }
    box(x - 5, top + 9, 10, 7, look.shirt); // body
    if (look.accent) box(x - 1, top + 9, 2, 5, look.accent);
    box(x - 4, top + 1, 8, 8, look.skin); // head
    box(x - 4, top, 8, 3, look.hair);
    box(x - 5, top + 1, 1, 4, look.hair);
    box(x + 4, top + 1, 1, 4, look.hair);
    box(x - 2, top + 5, 1, 1, '#1d1d24');
    box(x + 1, top + 5, 1, 1, '#1d1d24');
    // arms and hands
    const left = typing && frame % 2 ? 1 : 0;
    const right = typing && frame % 2 ? 0 : 1;
    box(x - 7, top + 10, 2, 5, look.shirt);
    box(x + 5, top + 10, 2, 5, look.shirt);
    box(x - 8, top + 14 + (typing ? left : 0), 2, 2, look.skin);
    box(x + 6, top + 14 + (typing ? right : 0), 2, 2, look.skin);
    if (mug) {
      box(x + 6, top + 11, 4, 4, '#ffffff');
      steam(x + 7, top + 11, frame);
    }
    if (alert) {
      box(x - 1, top - 9, 3, 5, '#ffb020');
      box(x - 1, top - 3, 3, 2, '#ffb020');
    }
  }

  /** Where the ball is right now: on the floor, or part-way through a throw with a hop. */
  function ballPosition(time) {
    const progress = Math.min((time - ball.thrownAt) / BALL_FLIGHT, 1);
    if (reducedMotion || progress >= 1) return { x: ball.x, y: ball.y, height: 0 };
    // One big arc, then a small bounce at the end.
    const height = progress < 0.75 ? Math.sin((progress / 0.75) * Math.PI) * 16 : Math.sin(((progress - 0.75) / 0.25) * Math.PI) * 4;
    return {
      x: ball.fromX + (ball.x - ball.fromX) * progress,
      y: ball.fromY + (ball.y - ball.fromY) * progress,
      height,
    };
  }

  function drawBall(time) {
    const { x, y, height } = ballPosition(time);
    box(x - 2, y, 4, 1, '#b9a67f'); // shadow on the floor
    const top = y - 5 - height;
    box(x - 2, top + 1, 4, 4, '#e0463c');
    box(x - 1, top, 2, 6, '#e0463c');
    box(x - 3, top + 2, 6, 2, '#e0463c');
    box(x - 1, top + 1, 1, 1, '#ffb3ad');
  }

  function throwBall(time) {
    const here = ballPosition(time);
    const landing = pick(BALL_SPOTS.filter((candidate) => Math.hypot(candidate.x - here.x, candidate.y - here.y) > 60));
    const spot = { x: landing.x - 9, y: landing.y }; // the dog stops just beside the ball
    Object.assign(ball, { fromX: here.x, fromY: here.y, x: landing.x, y: landing.y, thrownAt: time });
    if (reducedMotion) {
      // No running about: the dog is simply next to the ball again.
      Object.assign(dog, { x: spot.x, y: spot.y, state: 'sit', lovedUntil: time + 1500 });
      return;
    }
    dog.fetching = true;
    sendPet(dog, spot, 'sit', 9000);
  }

  function drawDog(time, frame) {
    const { x, y, facing } = dog;
    const coat = '#b9783f';
    const dark = '#8a5527';
    if (dog.state === 'sleep') {
      box(x - 6, y - 5, 12, 5, coat); // curled up
      box(x - 8, y - 5, 4, 4, coat);
      box(x - 8, y - 6, 2, 2, dark);
      box(x + 5, y - 3, 3, 2, dark); // tail tucked round
      const drift = frame % 6;
      box(x - 9 - (drift % 2), y - 9 - drift, 2, 1, '#ffffff'); // z z z
      box(x - 12 + (drift % 2), y - 13 - drift, 3, 1, '#ffffff');
    } else {
      const moving = dog.state === 'walk';
      const happy = dog.state === 'sit' || time < dog.lovedUntil;
      const sit = dog.state === 'sit' ? 1 : 0;
      const head = facing > 0 ? x + 3 : x - 8;
      const rear = facing > 0 ? x - 7 : x + 5;
      box(x - 5, y - 7 + sit, 10, 5 - sit, coat); // body
      box(x - 1, y - 7 + sit, 3, 5 - sit, '#d9a066'); // lighter patch
      box(head, y - 11, 5, 5, coat);
      box(facing > 0 ? head : head + 3, y - 12, 2, 3, dark); // ear
      box(facing > 0 ? head + 4 : head, y - 8, 1, 1, '#1d1d24'); // nose
      box(facing > 0 ? head + 3 : head + 1, y - 10, 1, 1, '#1d1d24'); // eye
      box(facing > 0 ? head : head + 4, y - 6, 1, 1, '#c0392b'); // collar
      box(rear, y - 9 + (happy && frame % 2 ? 1 : 0), 2, 3, dark); // tail
      const stride = moving && frame % 2 ? 1 : 0;
      box(x - 4, y - 2, 1, 2 - stride, dark);
      box(x - 2, y - 2, 1, 1 + stride, dark);
      box(x + 2, y - 2, 1, 2 - stride, dark);
      box(x + 4, y - 2, 1, 1 + stride, dark);
    }
    drawHeart(dog, time);
  }

  /** A small walking Claude spark: an orange starburst with eyes and feet. */
  function drawClaude(time, frame) {
    const { x } = claude;
    const moving = claude.state === 'walk';
    const y = claude.y - (moving && frame % 2 ? 1 : 0);
    const coat = '#d97757';
    const dark = '#b3563a';
    const twinkle = !moving && frame % 4 === 0 ? 1 : 0;
    const reach = 3 + twinkle;
    box(x - 1, y - 8 - reach, 2, reach, coat); // up
    box(x - 1, y - 4, 2, reach - 1, coat); // down
    box(x - 3 - reach, y - 7, reach, 2, coat); // left
    box(x + 3, y - 7, reach, 2, coat); // right
    for (const [stepX, stepY] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      box(x + stepX * 4 - (stepX < 0 ? 1 : 0), y - 6 + stepY * 4 - (stepY < 0 ? 1 : 0), 2, 2, coat);
      if (twinkle) box(x + stepX * 6 - (stepX < 0 ? 1 : 0), y - 6 + stepY * 6 - (stepY < 0 ? 1 : 0), 1, 1, coat);
    }
    box(x - 3, y - 9, 6, 6, coat); // body
    box(x - 2, y - 7, 1, 2, '#1d1d24'); // eyes
    box(x + 1, y - 7, 1, 2, '#1d1d24');
    const stride = moving && frame % 2 ? 1 : 0;
    box(x - 3 + stride, y - 1, 2, 1, dark); // feet
    box(x + 1 - stride, y - 1, 2, 1, dark);
    drawHeart(claude, time);
  }

  function drawHeart(pet, time) {
    if (time >= pet.lovedUntil) return;
    const rise = Math.floor((1500 - (pet.lovedUntil - time)) / 120);
    const heartX = pet.x - 2;
    const heartY = pet.y - 19 - rise;
    box(heartX, heartY, 2, 2, '#ff5a7a');
    box(heartX + 3, heartY, 2, 2, '#ff5a7a');
    box(heartX, heartY + 1, 5, 2, '#ff5a7a');
    box(heartX + 1, heartY + 3, 3, 1, '#ff5a7a');
    box(heartX + 2, heartY + 4, 1, 1, '#ff5a7a');
  }

  function draw(time) {
    const frame = reducedMotion ? 0 : Math.floor(time / 340);
    drawRoom(time, frame);
    const items = [];
    for (const [id, seat] of Object.entries(SEATS)) {
      const agent = agents[id];
      if (VISITORS.includes(id) && !agent) continue; // this office has no such visitor: no desk either
      const working = agent?.status === 'working';
      const away = VISITORS.includes(id) && (agent?.status || 'idle') === 'idle';
      if (!walkers.has(id) && !away) {
        items.push({
          y: seat.y,
          paint: () => drawPerson(seat.x, seat.y, LOOKS[id], { typing: working, frame, alert: agent?.status === 'waiting' }),
        });
      }
      items.push({ y: seat.y + 1, paint: () => drawDesk(id, seat, working, time, frame) });
    }
    for (const [id, walker] of walkers) {
      items.push({
        y: walker.y - 6,
        paint: () =>
          drawPerson(walker.x, walker.y - 6, LOOKS[id], {
            walking: !walker.pauseUntil,
            standing: Boolean(walker.pauseUntil),
            frame,
            mug: walker.mug,
          }),
      });
    }
    items.push({
      y: MEETING.y - 12,
      paint: () => {
        box(MEETING.x - 11, MEETING.y - 10, 22, 16, '#a5743f'); // meeting table
        box(MEETING.x - 11, MEETING.y + 6, 22, 5, '#70492a');
        box(MEETING.x - 5, MEETING.y - 6, 7, 5, '#f3f1ea'); // papers
        box(MEETING.x + 4, MEETING.y - 2, 3, 3, '#f5c518');
      },
    });
    items.push({ y: ball.y - 9, paint: () => drawBall(time) });
    items.push({ y: dog.y - 8, paint: () => drawDog(time, frame) });
    items.push({ y: claude.y - 8, paint: () => drawClaude(time, frame) });
    items.sort((first, second) => first.y - second.y).forEach((item) => item.paint());
    for (const piece of confetti) box(piece.x, piece.y, 2, 2, piece.colour);
  }

  // ---- movement -------------------------------------------------------------

  /** Moves something toward its next point. Returns the point when it arrives there. */
  function advance(mover, speed, delta) {
    const target = mover.points[0];
    const distanceX = target.x - mover.x;
    const distanceY = target.y - mover.y;
    const distance = Math.hypot(distanceX, distanceY);
    const travel = speed * delta;
    if (distance > travel) {
      mover.x += (distanceX / distance) * travel;
      mover.y += (distanceY / distance) * travel;
      if (Math.abs(distanceX) > 0.5) mover.facing = Math.sign(distanceX);
      return null;
    }
    mover.x = target.x;
    mover.y = target.y;
    return mover.points.shift();
  }

  function walk(id, points) {
    const home = standSpot(id);
    walkers.set(id, { x: home.x, y: home.y, pauseUntil: 0, mug: false, points });
  }

  function coffeeRun(id, time) {
    const home = standSpot(id);
    // About half the trips are for a coffee with milk, which means a stop at the fridge.
    const milk = Math.random() < 0.5
      ? [{ x: 86, y: 140, pause: 2800, arrive: (_walker, now) => (fridgeOpenUntil = now + 2800) }]
      : [];
    walk(id, [
      { x: home.x, y: CORRIDOR },
      { x: KITCHEN_DOOR.x, y: CORRIDOR },
      KITCHEN_DOOR,
      {
        ...COFFEE_SPOT,
        pause: 4000,
        arrive: (walker, now) => {
          brewingUntil = now + 4000;
          walker.mug = true;
        },
      },
      KITCHEN_DOOR,
      ...milk,
      { x: KITCHEN_DOOR.x, y: CORRIDOR },
      { x: home.x, y: CORRIDOR },
      { x: home.x, y: home.y, arrive: (_walker, now) => (hotMugUntil[id] = now + 25000) },
    ]);
    // The dog knows where the biscuits are kept.
    if (dog.state !== 'walk' && Math.random() < 0.6) sendPet(dog, { x: 58, y: 154 }, 'sit', 7000);
  }

  function sendPet(pet, target, then, stay) {
    pet.points = [{ x: pet.x, y: DOG_LANE }, { x: target.x, y: DOG_LANE }, { x: target.x, y: target.y }];
    pet.state = 'walk';
    pet.then = then;
    pet.stay = stay;
  }

  function stepPet(pet, time, delta) {
    if (pet.state === 'walk') {
      const zooming = time < (pet.zoomUntil || 0);
      const speed = zooming ? 95 : pet.fetching ? 70 : pet.kind === 'dog' ? 26 : 16;
      if (!pet.points.length || (advance(pet, speed, delta) && !pet.points.length)) {
        if (pet.fetching) {
          pet.fetching = false;
          pet.lovedUntil = time + 1500;
        }
        pet.state = pet.then;
        pet.until = time + (zooming ? 200 : pet.stay);
      }
    } else if (time < (pet.zoomUntil || 0)) {
      // Zoomies: dash from spot to spot until the excitement wears off.
      if (time > pet.until) sendPet(pet, pick(DOG_SPOTS.filter((spot) => spot.x !== pet.x)), 'sit', 8000);
    } else if (time > pet.until) {
      // The dog naps in its bed now and then; the Claude spark just keeps exploring.
      if (pet.kind === 'dog' && Math.random() < 0.4) sendPet(pet, DOG_BED, 'sleep', between(40000, 90000));
      else sendPet(pet, pick(DOG_SPOTS.filter((spot) => spot.x !== pet.x)), 'sit', between(12000, 30000));
    }
  }

  function step(time, delta) {
    for (const [id, walker] of walkers) {
      if (walker.pauseUntil) {
        if (time < walker.pauseUntil) continue;
        walker.pauseUntil = 0;
      }
      if (!walker.points.length) {
        walkers.delete(id);
        continue;
      }
      const reached = advance(walker, 34, delta);
      if (reached?.pause) walker.pauseUntil = time + reached.pause;
      reached?.arrive?.(walker, time);
    }
    for (const pet of pets) stepPet(pet, time, delta);
    for (const piece of confetti) {
      piece.y += piece.fall * delta;
      piece.x += Math.sin(time / 300 + piece.sway) * 12 * delta;
    }
    confetti = confetti.filter((piece) => piece.y < HEIGHT);
    if (time > nextCoffeeAt) {
      nextCoffeeAt = time + between(45000, 100000);
      // You get coffee too; staff only go while they are idle.
      const thirsty = Object.keys(SEATS).filter((id) => !VISITORS.includes(id) && (id === 'owner' || agents[id]?.status === 'idle') && !walkers.has(id));
      if (thirsty.length) coffeeRun(pick(thirsty), time);
    }
  }

  let last = performance.now();
  function loop(time) {
    if (!reducedMotion) step(time, Math.min((time - last) / 1000, 0.1));
    last = time;
    draw(time);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // Show a hand over the things you can click: the ball and the pets.
  canvas.addEventListener('mousemove', (event) => {
    const bounds = canvas.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) / bounds.width) * WIDTH;
    const y = ((event.clientY - bounds.top) / bounds.height) * HEIGHT;
    const spot = ballPosition(performance.now());
    const overBall = Math.abs(x - spot.x) <= 6 && Math.abs(y - (spot.y - 3 - spot.height)) <= 6;
    const overPet = pets.some((candidate) => Math.abs(x - candidate.x) <= 11 && Math.abs(y - (candidate.y - 6)) <= 10);
    canvas.style.cursor = overBall || overPet ? 'pointer' : '';
  });

  // Click the ball to throw it for the dog, or click a pet to give it a pat.
  canvas.addEventListener('click', (event) => {
    const bounds = canvas.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) / bounds.width) * WIDTH;
    const y = ((event.clientY - bounds.top) / bounds.height) * HEIGHT;
    const now = performance.now();
    const thrown = ballPosition(now);
    if (Math.abs(x - thrown.x) <= 6 && Math.abs(y - (thrown.y - 3 - thrown.height)) <= 6) {
      throwBall(now);
      return;
    }
    const pet = pets.find((candidate) => Math.abs(x - candidate.x) <= 11 && Math.abs(y - (candidate.y - 6)) <= 10);
    if (!pet) return;
    pet.lovedUntil = now + 1500;
    if (pet.state === 'sleep' && !reducedMotion) {
      pet.state = 'sit';
      pet.until = now + 4000;
    }
  });

  return {
    update(nextAgents) {
      const present = (list, id) => (list[id]?.status || 'idle') !== 'idle';
      for (const id of VISITORS) {
        const home = standSpot(id);
        const wasHere = present(agents, id);
        const isHere = present(nextAgents, id);
        if (reducedMotion || wasHere === isHere) continue;
        // A visitor walks in when their work starts and out again when it ends.
        if (isHere) walkers.set(id, { ...ENTRANCE, pauseUntil: 0, mug: false, points: [{ x: home.x, y: CORRIDOR }, home] });
        else walkers.set(id, { ...home, pauseUntil: 0, mug: false, points: [{ x: home.x, y: CORRIDOR }, ENTRANCE] });
      }
      agents = nextAgents;
    },
    setBoard(nextBoard) {
      board = nextBoard;
    },
    /** The team walks to the meeting table for the stand-up, then back to their desks. */
    gather() {
      if (reducedMotion) return;
      for (const [id, spot] of Object.entries(MEETING_SPOTS)) {
        if (walkers.has(id)) continue;
        const home = standSpot(id);
        walk(id, [
          { x: home.x, y: CORRIDOR },
          { x: spot.x, y: CORRIDOR },
          { ...spot, pause: 9000 },
          { x: spot.x, y: CORRIDOR },
          { x: home.x, y: CORRIDOR },
          { x: home.x, y: home.y },
        ]);
      }
    },
    /** Confetti falls and the dog gets the zoomies. */
    celebrate() {
      if (reducedMotion) return;
      const colours = ['#ff5a7a', '#f5c518', '#4c9aff', '#36b37e', '#b07cf0', '#ff8f6b'];
      for (let count = 0; count < 110; count += 1) {
        confetti.push({ x: between(0, WIDTH), y: between(-120, 0), fall: between(28, 60), sway: between(0, 6), colour: pick(colours) });
      }
      const now = performance.now();
      dog.zoomUntil = now + 9000;
      dog.lovedUntil = now + 1500;
      if (dog.state === 'sleep') dog.state = 'sit';
      dog.until = now;
    },
    /** Someone walks over to someone else's desk, pauses, and walks back. */
    visit(from, to) {
      if (reducedMotion || !SEATS[from] || !SEATS[to] || walkers.has(from)) return;
      const home = standSpot(from);
      const there = standSpot(to);
      walk(from, [
        { x: home.x, y: CORRIDOR },
        { x: there.x, y: CORRIDOR },
        { x: there.x, y: there.y, pause: 1400 },
        { x: there.x, y: CORRIDOR },
        { x: home.x, y: CORRIDOR },
        { x: home.x, y: home.y },
      ]);
    },
  };
}
