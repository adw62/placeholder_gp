// =====================================================================
// Central tuning. Everything that affects game feel lives here so it
// can be tweaked without touching systems code.
// Units: meters, seconds, radians. The placeholder car is kart-scale
// (~1.4 m long), so speeds are scaled to match.
// =====================================================================

export const CONFIG = {
  wheelBase: 1.0, // front axle z (0.48) minus rear axle z (-0.52) — BASE value; see carScale
  // Single "resize the player car" knob — placeholders.js/physics.js/main.js
  // all derive rig scale, wheelbase/cgHeight/carRadius, and camera/wheel-roll
  // from this instead of being hand-tuned separately. AI cars are NOT scaled by it.
  carScale: 1.5,
  crowdScale: 0.65, // uniform scale for crowd figures; 0.65 = human-sized next to the 1.5x car

  physics: {
    // ---- rigid body ----
    mass: 3,           // relative mass: divides engine/brake force response
    gyration: 0.6,     // yaw radius of gyration (m): higher = lazier, heavier rotation
    cgToFront: 0.52,   // CG -> front axle distance, as a fraction of wheelBase (0..1). CG forward = stable
    cgHeight: 0.3,     // BASE height (m) — see carScale. Higher = stronger weight transfer under brake/throttle

    // ---- engine / brakes ----
    maxSpeed: 45,      // m/s, top speed on tarmac — raised for more arcade pace/sense of speed
    maxReverse: 7,
    engineAccel: 9.5,  // engine force / unit mass; effective accel = this / mass — quicker off the line
    brakeDecel: 6,
    reverseAccel: 4,
    brakeBias: 0.65,   // fraction of brake force on the front axle
    dragK: 0.0215,     // quadratic drag
    rollingResist: 0.5,
    slopeGravity: 1,   // multiplier on gravity-along-the-road (1 = physically accurate g·sinθ); climbing resists, descending assists — see CarPhysics.update

    // ---- drivetrain & wheelspin: excess torque spins a tire up, which pushes
    // weaker AND loses lateral grip (burnouts / power-on washouts) ----
    drivetrain: "rwd",      // "rwd" | "fwd" | "awd"
    awdFrontShare: 0.4,     // AWD only: fraction of torque to the front axle
    launchTorque: 2.2,      // extra torque multiplier at standstill (low gearing)
    launchFade: 4,          // m/s where the launch torque is gone
    wheelspinLongLoss: 0.45,// how much weaker a fully spinning tire pushes
    wheelspinLatLoss: 0.25, // how much lateral grip a fully spinning tire loses
    spinRise: 1.5,          // spin-up rate per m/s² of excess torque
    spinDecay: 6.4,         // 1/s recovery once traction returns

    // ---- steering (smooth but responsive: the car takes a set, GT-style) ----
    // Max wheel angle is speed-dependent: full lock when parked, a small
    // precise angle at top speed, blended by steerShape.
    maxSteer: 0.33,         // rad, wheel angle at standstill
    maxSteerHigh: 0.11,     // rad, wheel angle at top speed (countersteer authority) — raised a
                              // touch so opposite lock has enough bite to actually stop the yaw
                              // once you're sideways at speed, not just trim it
    steerShape: 1.15,       // <1 = angle drops off early, >1 = holds until fast
    steerSpeed: 1.6,        // rad/s toward target — raised from 1.2 so a countersteer input
                              // reaches the wheels fast enough to catch a slide before it snaps
    steerReturnSpeed: 3.5,  // rad/s back to center
    maxYawRate: 3.5,        // safety cap only — the tire model self-limits

    // ---- assists & aero: the GT1/2 "arcade sim" layer (see physics.js) ----
    steerAssist: 0.36,       // 0..1 grip-optimal steering limiter: raised a notch from 0.3 for an
                              // easier-to-place front end — still well short of 0.5 (which glued the
                              // front near-optimal and pushed all the breakaway onto the rear)
    stabilityAssist: 0.55,   // 0..1 fills rear post-peak falloff: raised again (was 0.4, before that
                              // 0.25) so a slide gathers itself hard and is easy to catch on the
                              // countersteer — big slides still start (yaw momentum can exceed
                              // capacity), they just stop reading as a coin-flip into a spin
    downforce: 0.02,        // extra axle load = downforce·v² (per-mass units); plants the car at speed
    aeroBalance: 0.5,       // fraction of downforce on the front axle

    // ---- tires: simplified Pacejka, Fy = cap·sin(C·atan(B·α)) ----
    // Peak slip angle ≈ tan(π/(2C))/B; sin(C·π/2) = grip left past the peak.
    // GT balance: front peaks EARLIER and sheds more grip past it, rear peaks
    // later and keeps almost all of it — the default limit behavior is a
    // progressive push, and the rear only comes around when provoked
    // (power, handbrake, big weight transfer), then comes back.
    // tireFront.C brought down toward tireRear.C so the front, once it does
    // break away (see steerAssist above), stays catchable instead of washing
    // out into a hard plow — both axles now fall off the same forgiving way,
    // which is what reads as a controllable 4-wheel slide instead of
    // understeer-then-spin.
    mu: 0.86,                        // peak friction (lateral limit ≈ μ·g ≈ 8.4 m/s²) — raised from
                                      // 0.78 so more corners are flat-out or lift-only: the arcade
                                      // read is "carry speed and catch it", not "brake for every apex"
    tireFront: { B: 11, C: 1.3 },    // peak ≈ 9.0°, far tail keeps 89% grip (was 71% at C 1.5)
    tireRear:  { B: 22, C: 1.25 },   // peak ≈ 8.1°, far tail keeps 92% grip — C is THE slide-feedback knob
    lowSpeedGripBoost: 0.1, // extra μ at standstill (tires bite when slow)
    lowSpeedGripFade: 15.5, // m/s at which the low-speed boost is fully gone
    vBlend: 2.5,             // below this speed, blend to kinematic steering
    handbrakeLatFactor: 0.15, // handbrake ~kills rear lateral capacity

    offroad: { grip: 0.24, drag: 1.6, power: 0.55 },

    // No wallRestitution knob: all contact is fully inelastic and position-only
    // by design. Nothing in the game adds velocity on an impact.
    //
    // Omnidirectional radius, BASE value (x carScale). Not used for barriers —
    // that's the oriented footprint below. Still used by the tuning lab's
    // circular obstacles and damage.js's dent offset.
    carRadius: 0.5,
    // Oriented footprint: a car is ~2.2x longer than wide, so one radius is
    // wrong in both directions at once. Used as a rectangle around each car's
    // heading by both the car-vs-car bump (main.js's obbOverlap) and barrier
    // collision, so the same shape stops the car against a wall as blocks
    // another car. BASE values, x carScale.
    // Deliberately ~91% of the tightest rigged car (0.459 half-width, 1.080
    // half-length — the wheels are the widest point), so contact reads as
    // touching rather than stopping short. That margin is also why a car's own
    // `scale` isn't applied: the footprint stays uniform across models.
    carHalfLength: 0.655,   // 0.98 m at carScale 1.5 (vs 1.08 shortest car)
    carHalfWidth: 0.28,     // 0.42 m at carScale 1.5 (vs 0.459 narrowest car)
  },

  drift: { minSlip: 0.1, minSpeed: 1.5, scoreRate: 12 },

  // Nitro-style arcade boost (main.js/physics.js/hud.js): a meter that fills
  // itself from driving expressively (drifting, lighting up the tires) and
  // drains while held (the boost key) — no pickups, purely a reward loop
  // layered on the existing drift/wheelspin signals. Applied as extra drive
  // force + a raised top-speed ceiling inside CarPhysics.update (input.boost),
  // never by mutating CONFIG.physics itself — that's shared by every AI car's
  // own CarPhysics instance. AI opponents (game/src/ai.js) run their own
  // meter through these same constants; CONFIG.ai.boostAI holds their
  // separate decision-to-spend tuning.
  boost: {
    max: 100,             // meter units
    startAmount: 35,      // start each race with a partial tank — one short burst is available immediately
    fillDriftRate: 24,     // meter/s while actively drifting on the road
    fillBurnoutRate: 16,   // meter/s while wheelspinning hard (rewards launches/powerslides too)
    drainRate: 55,         // meter/s while the boost key is held
    minToStart: 8,         // needs at least this much queued so a near-empty tank can't sputter for 1 frame
    forceAccel: 5,          // extra engine-force-equivalent (per unit mass) while boosting — a firm
                              // shove, not a rocket (was 10)
    topSpeedBonus: 4,       // extra m/s ceiling while boosting, on top of physics.maxSpeed (was 10)
    fovKick: 3,              // extra camera fov while boosting (was 9) — a light widen, not a lurch
  },

  // Impact/speed "juice" — screen-space feedback that isn't part of the sim.
  juice: {
    hitStop: {
      threshold: 6,     // impact speed (m/s) that qualifies as a "big" hit — kerb taps stay silent
      duration: 0.09,   // seconds the sim runs in slow motion after a big hit
      timeScale: 0.12,  // how much it slows (this fraction of real speed)
      fovKick: 16,       // camera fov punch on trigger, decays away below
      fovKickDecay: 7,   // 1/s exponential decay rate of that punch
    },
    // Afterimage-style motion blur (main.js's EffectComposer/AfterimagePass),
    // replacing the old radial speed-line overlay — same speed-fraction input,
    // a subtler read. `damp` is the pass's own per-frame retention (0 = no
    // blur, closer to 1 = long smeary trails); kept low on purpose ("light").
    motionBlur: {
      startFrac: 0.45,  // fraction of maxSpeed where blur starts fading in
      maxDamp: 0.16,    // damp at/above top speed
      boostDamp: 0.26,  // damp while actively boosting (overrides the speed-based value)
    },
  },

  render: {
    // Scenery chunks and billboards past this distance aren't drawn — the
    // aggressive PS1 pop-in look. Raise toward the fog far (~320) to hide
    // the pop under fog instead; live slider in tuning lab -> Video.
    drawDistance: 100,
    // Internal render height in pixels (PS1 ran ~240); width follows the
    // window aspect. The canvas upscales with nearest-neighbor. Raise
    // toward native height to soften back to a modern look.
    internalHeight: 312,
    // 1 = PS1 texture sampling: nearest, no mipmaps — raw texel crawl
    // instead of bilinear/mipmap averaging (which reads as fuzz at 240p).
    // 0 = modern smooth sampling.
    ps1Textures: 1,
  },

  camera: {
    modes: [
      { name: "chase", dist: 3.3, height: 0.6, lookAhead: 5 },
      { name: "far",   dist: 6.5, height: 2.4, lookAhead: 3 },
      { name: "hood",  dist: 0,   height: 0 },
    ],
    baseFov: 55,
    hoodFov: 62,
    speedFov: 12,   // extra fov at top speed
    lerp: 6,
    zoomMin: 0.6, zoomMax: 1.9,
  },

  speedDisplayScale: 2.8,   // arcade multiplier for the HUD speedo (kart scale -> big numbers)
  gearSpeeds: [0, 1, 4, 6, 8, 9, 10], // fake gearbox for audio/HUD

  audio: {
    // Additive-harmonic engine synth (see GameAudio.setEngine in audio.js).
    // A 4-stroke fires cylinders/2 times per crank rev, so that harmonic
    // (growlGain) is the main pitch a listener locks onto — 3x for a
    // 6-cylinder; bodyGain (2x) fills it out, raspGain (cylinders x) adds
    // high-rev buzz, chugDepth is the idle "putter". pitchGlide: lower =
    // sharper snap on a gearshift's rpm drop, higher = smoother/muffled.
    engine: {
      idleRpm: 1850,
      maxRpm: 5500,
      cylinders: 3,
      rumbleGain: 0.45,
      growlGain: 0.9,
      bodyGain: 0.7,
      raspGain: 0.75,
      chugDepth: 0.7,
      toneCutoffBase: 740,    // Hz, lowpass cutoff at idle (muffled)
      toneCutoffRpmGain: 4700,// extra Hz at redline (brightens with revs)
      gainBase: 0.045,        // idle volume
      gainLoad: 0.035,        // extra volume under throttle
      pitchGlide: 0.14,       // seconds
    },
    // Broad rubber-on-tarmac rumble under any slide (bandpassed noise).
    skid: { gain: 0.31, freqBase: 560, freqRise: 800 },
    // The pitched squeal on top (audio.js): detuned oscillators through a
    // resonant "formant" bandpass (raw saws sound like an alarm), plus a
    // noise-driven amplitude flutter — the irregular stick-slip stutter
    // that makes it read as tire, not synth. All live in tuning lab -> SFX.
    squeal: {
      toneGain: 0.18,   // pitched-whine volume
      noiseGain: 0.25,  // high rasp band volume
      freqBase: 2100,   // Hz at squeal onset
      freqRise: 1000,   // extra Hz at full slip
      detune: 20,       // cents between the two oscillators (slow beating)
      formantQ: 2.6,    // resonance: higher = hollower/more vowel-like
      vibratoRate: 10,  // Hz, slow pitch wobble
      vibratoDepth: 390,// Hz swing of that wobble at full squeal
      flutterDepth: 0.55,// 0..1 stick-slip amplitude stutter
      threshold: 0.08,  // slip amount where squeal starts
      range: 0.6,       // slip span over which it reaches full strength
    },
  },

  ai: {
    enabled: true,      // false = solo time trial (no opponents built at all)
    lateralAccel: 11,   // cornering limit used to compute their racing speed (feeds track.js's vtAI table)
                          // — scaled up alongside physics.mu so the pack still corners like it belongs
                          // at the player's new (grippier, faster) pace instead of falling behind
    brake: 8.6,          // braking-lookahead rate for the same vtAI table
    maxSpeed: 23,        // scaled up alongside physics.maxSpeed/engineAccel (see above)
    skills: [0.93, 0.97, 1.01],          // per-opponent speed factor
    colors: [0xe74c3c, 0x3498db, 0xf1c40f],
    offsets: [-1.8, 0, 1.8],             // preferred lateral line
    rubberBand: { gain: 0.0006, min: 0.93, max: 1.07 },
    // AI cars now collide as real bodies (the same oriented footprint the
    // player uses — CONFIG.physics.carHalfLength/carHalfWidth, see main.js's
    // bump block) instead of each side having its own collision radius.
    // Position-only contact (no velocity impulse — that read as cars
    // bouncing/repelling off each other, and no per-frame speed drain
    // either — that compounded every frame of sustained contact and could
    // stall a car in under a second of door-to-door rubbing) split
    // unevenly so it still reads as "equal but a little in the player's
    // favour": the AI gives up more ground per overlap than the player
    // does, but neither one launches off — or grinds to a halt on — the
    // other; two cars running side by side should be able to rub doors
    // and slide past without either one stopping.
    bump: {
      pushPlayerShare: 0.4, pushAiShare: 0.6,  // overlap-correction split
    },
    // Corner assist (game/src/ai.js): rolled once per corner (using
    // CONFIG.track.kerbMinCurv as the "is this actually a corner" gate) so
    // that fraction of corners gets a gentle pull back toward the spline
    // line — cuts down how often the raw physics spins the AI out, while
    // leaving the rest fully raw so spins still happen sometimes on purpose.
    cornerAssist: {
      chance: 0.9,       // fraction of corners that get the assist
      headingRate: 8,    // 1/s blend of heading toward the spline tangent
      latDamp: 6,        // 1/s bleed-off of the slide (lateral) component of velocity
    },
    // Awareness (game/src/ai.js): a following-distance safety net, independent
    // of which lane anyone's in (see `lanes` below for the actual line
    // choice) — whoever's directly ahead in roughly this car's own path gets
    // its speed matched rather than driven into, since a lane switch takes a
    // moment to carry out.
    awareness: {
      lookAhead: 9,           // base scan distance (m) ahead for a blocking car
      lookAheadSpeedMul: 0.6, // + this * own speed, so faster cars look further ahead
      lateralThreshold: 2.6,  // m either side of the AI's own line that counts as "in the way"
      brakeDist: 7,           // inside this following distance, cap speed to the blocker's own...
      brakeMargin: 2,         // ...speed plus this margin, so it doesn't ride the bumper flat out
    },
    // Lanes (game/src/ai.js): three discrete lines across the road — inside,
    // the spline itself (mid), and outside — rather than a small reactive
    // nudge, which read as too subtle to notice. Re-picked on every
    // straight<->corner transition (see pickLane): entering a corner
    // prefers the inside line (the racing line — see barriers.js's own
    // -sign*curv "concave face" test, reused here for which side inside
    // IS); entering a straight has no inside/outside to prefer, so it just
    // prefers the car's own habitual line (its baseOffset's side). Either
    // way, falls back through the other two lines if the preferred one's
    // already claimed — by another AI actually committed to it (compared
    // against its own chosen lane, not wherever it happens to be cruising)
    // or by the player's literal current position.
    lanes: {
      offsetFrac: 0.62,     // inside/outside lane offset, as a fraction of the track's usable half-width
      aheadDist: 20,        // m of arc-length ahead another car's own lane claim reaches
      behindDist: 6,        // ...and behind — a car just passed still holds its line for a moment
      // Fraction of the (small, track-width-dependent) lane offset itself —
      // not a fixed meter value: these tracks run 5.6-7m wide, so a fixed
      // tolerance sized for a wide track swallowed the entire lane spacing
      // on a narrow one and made every corner look fully occupied.
      lateralTolFrac: 0.5,
      switchRate: 3,        // 1/s ease onto the newly picked line — no snapping between lanes
    },
    // AI boost usage (game/src/ai.js): spends the same CONFIG.boost tank the
    // player has (filled by the same drift/wheelspin reward loop) either to
    // force a pass on a blocking car or, once comfortably full, just to burn
    // it off on an open straight — never mid-corner, where the extra top
    // speed only feeds a spin instead of buying anything.
    boostAI: {
      cruiseThreshold: 55, // meter needed before a cruise-boost is even considered
      cruiseChance: 0.15,  // chance/sec of one triggering once eligible
      duration: 2,         // seconds a triggered cruise-boost holds the throttle down
    },
  },

  track: {
    samples: 700,      // spline resolution (physics + meshes)
    checkpoints: 12,   // anti-shortcut sectors per lap
    wallMargin: 2.2,   // barrier distance beyond road edge
    wallHeight: 0.55,
    kerbWidth: 0.9,
    kerbMinCurv: 1 / 45, // kerbs appear where corner radius < 45 m
  },
};
