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
    maxSpeed: 38,      // m/s, top speed on tarmac
    maxReverse: 7,
    engineAccel: 8,    // engine force / unit mass; effective accel = this / mass
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
    maxSteerHigh: 0.09,     // rad, wheel angle at top speed (countersteer authority)
    steerShape: 1.15,       // <1 = angle drops off early, >1 = holds until fast
    steerSpeed: 1.2,        // rad/s toward target
    steerReturnSpeed: 3.5,  // rad/s back to center
    maxYawRate: 3.5,        // safety cap only — the tire model self-limits

    // ---- assists & aero: the GT1/2 "arcade sim" layer (see physics.js) ----
    steerAssist: 0.5,       // 0..1 grip-optimal steering limiter: full stick = peak front grip + subtle auto-countersteer
    stabilityAssist: 0.1,   // 0..1 fills rear post-peak falloff: slides start but don't snap into spins
    downforce: 0.02,        // extra axle load = downforce·v² (per-mass units); plants the car at speed
    aeroBalance: 0.5,       // fraction of downforce on the front axle

    // ---- tires: simplified Pacejka, Fy = cap·sin(C·atan(B·α)) ----
    // Peak slip angle ≈ tan(π/(2C))/B; sin(C·π/2) = grip left past the peak.
    // GT balance: front peaks EARLIER and sheds more grip past it, rear peaks
    // later and keeps almost all of it — the default limit behavior is a
    // progressive push, and the rear only comes around when provoked
    // (power, handbrake, big weight transfer), then comes back.
    mu: 0.85,                        // peak friction (lateral limit ≈ μ·g ≈ 8.3 m/s²)
    tireFront: { B: 11, C: 1.5 },    // peak ≈ 9.0°, far tail keeps 71% grip
    tireRear:  { B: 22, C: 1.25 },   // peak ≈ 8.1°, far tail keeps 92% grip — C is THE slide-feedback knob
    lowSpeedGripBoost: 0.1, // extra μ at standstill (tires bite when slow)
    lowSpeedGripFade: 15.5, // m/s at which the low-speed boost is fully gone
    vBlend: 2.5,             // below this speed, blend to kinematic steering
    handbrakeLatFactor: 0.15, // handbrake ~kills rear lateral capacity

    offroad: { grip: 0.24, drag: 1.6, power: 0.55 },

    wallRestitution: 0.35,
    carRadius: 0.5,         // collision radius vs walls / other cars
  },

  drift: { minSlip: 0.1, minSpeed: 1.5, scoreRate: 12 },

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
      { name: "chase", dist: 4.2, height: 1.6 },
      { name: "far",   dist: 6.5, height: 2.4 },
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
    enabled: false,     // opponents temporarily disabled — flip to bring them back
    lateralAccel: 9.5,  // cornering limit used to compute their racing speed
    accel: 5,
    brake: 7.5,
    maxSpeed: 20,
    skills: [0.93, 0.97, 1.01],          // per-opponent speed factor
    colors: [0xe74c3c, 0x3498db, 0xf1c40f],
    offsets: [-1.8, 0, 1.8],             // preferred lateral line
    rubberBand: { gain: 0.0006, min: 0.93, max: 1.07 },
    radius: 0.55,
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
