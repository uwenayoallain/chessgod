import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseZoneTemp, packageTempFrom, thermalCeiling, readPackageTempC, createTempWindow,
} from './thermal.mjs'

// The zone set this box actually reports, including the two that are not
// thermometers: TCPU is unpopulated and INT3400 is a policy device.
const zones = [
  { type: 'INT3400 Thermal', temp: '20000' },
  { type: 'SEN1', temp: '71050' },
  { type: 'SEN2', temp: '90050' },
  { type: 'SEN3', temp: '68050' },
  { type: 'SEN4', temp: '70050' },
  { type: 'TCPU', temp: '-273150' },
  { type: 'iwlwifi_1', temp: '67000' },
  { type: 'x86_pkg_temp', temp: '90000' },
]

test('millidegrees are read as celsius', () => {
  assert.equal(parseZoneTemp('90000'), 90)
  assert.equal(parseZoneTemp(' 63500\n'), 63.5)
})

test('a temp file that is not a number reads as null, not NaN', () => {
  // NaN would silently compare false against both thresholds and leave the
  // crawler running hot rather than falling back to the contention guards.
  for (const bogus of ['', '   ', 'n/a', undefined, null, '12.5', '0x40']) {
    assert.equal(parseZoneTemp(bogus), null)
  }
})

test('x86_pkg_temp wins outright, even when another zone reads hotter', () => {
  const hotterSensor = [{ type: 'SEN2', temp: '97000' }, { type: 'x86_pkg_temp', temp: '90000' }]
  assert.equal(packageTempFrom(hotterSensor), 90)
})

test('the real zone set resolves to the package reading', () => {
  assert.equal(packageTempFrom(zones), 90)
})

test('without x86_pkg_temp the hottest plausible zone stands in', () => {
  // SEN2 tracks the package within a degree on this box. The unpopulated -273C
  // zone and the flat 20C policy device must not be picked up by the max.
  assert.equal(packageTempFrom(zones.filter(z => z.type !== 'x86_pkg_temp')), 90.05)
})

test('a machine with no plausible sensor reads as null', () => {
  assert.equal(packageTempFrom([{ type: 'TCPU', temp: '-273150' }]), null)
  assert.equal(packageTempFrom([]), null)
  assert.equal(packageTempFrom(null), null)
})

const limits = { hotC: 85, coolC: 75, fullMax: 5 }

test('a cool machine is left to the other guards', () => {
  // 63-67C is the measured baseline once the crawler stops; nothing here should
  // constrain the pool at that temperature.
  assert.deepEqual(thermalCeiling({ ...limits, tempC: 65, wasHot: false }), { ceiling: 5, hot: false })
})

test('the transient spikes of ordinary use do not trip the guard', () => {
  // Measured: normal use spikes to 83C and recovers without throttling. A guard
  // that stood down there would stop the crawl every time someone opened a tab.
  // The pool keeps working; it is held at its current size rather than grown,
  // because 83C is warm enough that there is nothing spare to grow into.
  assert.deepEqual(
    thermalCeiling({ ...limits, tempC: 83, wasHot: false, active: 3 }),
    { ceiling: 3, hot: false },
  )
})

test('the sustained band where throttling starts stands the pool down entirely', () => {
  // 88-91C is where the package spent thirty hours, throttling every core.
  assert.deepEqual(thermalCeiling({ ...limits, tempC: 88, wasHot: false }), { ceiling: 0, hot: true })
})

test('once hot it stays down through the whole gap, not just below the trip point', () => {
  // The flapping case: cooling one degree past HOT_C must not release the pool,
  // or the machine settles at exactly the temperature that made it slow.
  assert.deepEqual(thermalCeiling({ ...limits, tempC: 84, wasHot: true }), { ceiling: 0, hot: true })
  assert.deepEqual(thermalCeiling({ ...limits, tempC: 76, wasHot: true }), { ceiling: 0, hot: true })
})

test('work resumes only after a genuine recovery', () => {
  // At the recovery threshold itself the pool restarts but does not fill: the
  // package is still warm. Once it is properly cool the load budget governs
  // again and the whole pool is available.
  assert.deepEqual(
    thermalCeiling({ ...limits, tempC: 75, wasHot: true, active: 0 }),
    { ceiling: 1, hot: false },
  )
  assert.deepEqual(
    thermalCeiling({ ...limits, tempC: 67, wasHot: true, active: 0 }),
    { ceiling: 5, hot: false },
  )
})

test('recovery reads the short window, so a package that let go is not made to wait', () => {
  // The measured case this exists for: the pool stops, the package falls from
  // 85C to 66C within two seconds, and the 30s trip mean is still carrying hot
  // samples. Judged on that mean the crawler idles at 55-62C -- well under its
  // own threshold -- for the rest of the window.
  // It resumes (hot: false) rather than waiting out the long window; the warm
  // band then holds it at one engine, because the 30s mean is still 84C.
  assert.deepEqual(
    thermalCeiling({ ...limits, tempC: 84, coolTempC: 66, wasHot: true, active: 0 }),
    { ceiling: 1, hot: false },
  )
})

test('a short window that is still hot does not release the pool early', () => {
  // The asymmetry only skips dead time. While the package is genuinely hot,
  // both windows agree and the pool stays down.
  assert.deepEqual(
    thermalCeiling({ ...limits, tempC: 87, coolTempC: 86, wasHot: true }),
    { ceiling: 0, hot: true },
  )
})

test('the short window never lets a cool spell trip the guard in the first place', () => {
  // Only recovery is judged on it. Going hot stays on the long mean, or one
  // cool sample inside a soak would keep re-arming the pool.
  assert.deepEqual(
    thermalCeiling({ ...limits, tempC: 88, coolTempC: 70, wasHot: false }),
    { ceiling: 0, hot: true },
  )
})

test('without a short window the guard behaves exactly as it did', () => {
  assert.deepEqual(thermalCeiling({ ...limits, tempC: 84, wasHot: true }), { ceiling: 0, hot: true })
  assert.deepEqual(
    thermalCeiling({ ...limits, tempC: 84, coolTempC: null, wasHot: true }),
    { ceiling: 0, hot: true },
  )
})

test('the warm band holds the pool where it is rather than growing into the trip', () => {
  // One engine alone holds this package at 83-86C against a 54-60C idle, so
  // there is no headroom for a second. Releasing the full pool the moment the
  // guard clears would grow into that and buy a stand-down.
  assert.deepEqual(
    thermalCeiling({ ...limits, tempC: 83, coolTempC: 83, wasHot: false, active: 1 }),
    { ceiling: 1, hot: false },
  )
  assert.deepEqual(
    thermalCeiling({ ...limits, tempC: 82, coolTempC: 82, wasHot: false, active: 3 }),
    { ceiling: 3, hot: false },
  )
})

test('the warm band still starts a recovered pool', () => {
  // Holding growth must not mean holding at zero: a pool that just came back
  // from a stand-down has to be allowed its first engine.
  assert.deepEqual(
    thermalCeiling({ ...limits, tempC: 81, coolTempC: 70, wasHot: true, active: 0 }),
    { ceiling: 1, hot: false },
  )
})

test('a genuinely cool machine is unaffected and fills as before', () => {
  // A desktop with real cooling never reaches coolC, so the band never binds
  // and the load budget governs the pool exactly as it did.
  assert.deepEqual(
    thermalCeiling({ ...limits, tempC: 65, coolTempC: 65, wasHot: false, active: 1 }),
    { ceiling: 5, hot: false },
  )
})

test('an unmeasurable machine runs on the contention guards alone', () => {
  // Refusing to run forever on a box with no thermometer would be a worse bug
  // than the one this module exists to fix.
  assert.deepEqual(thermalCeiling({ ...limits, tempC: null, wasHot: false }), { ceiling: 5, hot: false })
  assert.deepEqual(thermalCeiling({ ...limits, tempC: null, wasHot: true }), { ceiling: 5, hot: false })
})

test('sysfs is walked for the package zone', () => {
  const files = {
    '/sys/class/thermal/thermal_zone0/type': 'SEN1',
    '/sys/class/thermal/thermal_zone0/temp': '71050',
    '/sys/class/thermal/thermal_zone1/type': 'x86_pkg_temp',
    '/sys/class/thermal/thermal_zone1/temp': '88000',
  }
  const temp = readPackageTempC({
    readdir: () => ['thermal_zone0', 'thermal_zone1', 'cooling_device0'],
    read: path => {
      if (!(path in files)) throw new Error(`ENOENT ${path}`)
      return files[path]
    },
  })
  assert.equal(temp, 88)
})

test('an unreadable zone is skipped rather than losing the whole reading', () => {
  // Zones come and go across suspend; one EACCES must not blind the guard.
  const temp = readPackageTempC({
    readdir: () => ['thermal_zone0', 'thermal_zone1'],
    read: path => {
      if (path.includes('thermal_zone0')) throw new Error('EACCES')
      return path.endsWith('/type') ? 'x86_pkg_temp' : '86000'
    },
  })
  assert.equal(temp, 86)
})

test('a sysfs that cannot be listed reads as null', () => {
  assert.equal(readPackageTempC({ readdir: () => { throw new Error('ENOENT') }, read: () => '' }), null)
})

// The package temperature measured over two minutes with the crawler fully
// stopped, a browser and a music player running -- the machine's ordinary
// state. This trace is the regression: the first version of the guard compared
// it against an instant 85C, tripped on the spikes, and starved the crawler to
// 0.00% CPU while 90% of the machine sat idle.
const ambient = [
  88, 84, 71, 73, 82, 70, 69, 71, 86, 68, 83, 87,
  90, 83, 86, 70, 75, 77, 71, 75, 69, 71, 67, 64,
]
// What a crawling package holds, from the same box.
const soaking = [88, 89, 90, 91, 89, 88, 90, 89, 91, 88, 89, 90]

/** Every state the guard passes through when fed a trace sample by sample. */
function run(trace, { hotC = 85, coolC = 80, fullMax = 5 } = {}) {
  const window = createTempWindow()
  const states = []
  let hot = false
  for (const sample of trace) {
    window.push(sample)
    const next = thermalCeiling({ tempC: window.mean(), hotC, coolC, wasHot: hot, fullMax })
    hot = next.hot
    states.push(next)
  }
  return states
}

test('an idle desktop never trips the guard, spikes to 90C included', () => {
  // The whole point. Five of these samples are at or above the 85C trip, and
  // none of them is the crawler's doing.
  assert.equal(run(ambient).some(state => state.hot), false)
})

test('a sustained crawl soak does trip it', () => {
  assert.equal(run(soaking).some(state => state.hot), true)
})

test('the soak is caught inside one window rather than after minutes', () => {
  const states = run(soaking)
  assert.equal(states.findIndex(state => state.hot), 5)
})

test('the guard waits for a full window before judging anything', () => {
  // A crawler that started during a spike must not stand down on its first
  // reading, and one that started cool must not be licensed by it either.
  const window = createTempWindow()
  for (const sample of [90, 90, 90, 90, 90]) {
    window.push(sample)
    assert.equal(window.mean(), null)
  }
  window.push(90)
  assert.equal(window.mean(), 90)
})

test('a single spike cannot reach the trip through the mean', () => {
  // 64C ambient with one 100C outlier averages to 70C: exactly the discrimination
  // an instantaneous reading could not make.
  const window = createTempWindow()
  for (const sample of [64, 64, 64, 64, 64, 100]) window.push(sample)
  assert.equal(window.mean(), 70)
  assert.equal(thermalCeiling({ tempC: window.mean(), hotC: 85, coolC: 80, wasHot: false, fullMax: 5 }).hot, false)
})

test('recovery from a soak happens once ambient returns, not before', () => {
  const window = createTempWindow()
  for (const sample of soaking) window.push(sample)
  let hot = thermalCeiling({ tempC: window.mean(), hotC: 85, coolC: 80, wasHot: false, fullMax: 5 }).hot
  assert.equal(hot, true)
  // Cooling into the low 80s is not yet a recovery; the ambient trace lives there.
  for (const sample of [84, 83, 82, 84, 83, 82]) window.push(sample)
  hot = thermalCeiling({ tempC: window.mean(), hotC: 85, coolC: 80, wasHot: hot, fullMax: 5 }).hot
  assert.equal(hot, true)
  for (const sample of [70, 71, 69, 72, 70, 71]) window.push(sample)
  hot = thermalCeiling({ tempC: window.mean(), hotC: 85, coolC: 80, wasHot: hot, fullMax: 5 }).hot
  assert.equal(hot, false)
})

test('samples that cannot be read are skipped, not counted as cool', () => {
  const window = createTempWindow()
  for (const sample of [90, 90, null, 90, undefined, 90, 90, NaN, 90]) window.push(sample)
  assert.equal(window.mean(), 90)
})
