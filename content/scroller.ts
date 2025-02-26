declare const enum ScrollConsts {
    calibrationBoundary = 150, maxCalibration = 1.6, minCalibration = 0.5, SpeedChangeInterval = 47,
    minDuration = 100, durationScaleForAmount = 20,
    maxS = 1.05, minS = 0.95, delayToChangeSpeed = 75, tickForUnexpectedTime = 17, firstTick = 17,
    FirefoxMinFakeInterval = 100, // https://developer.mozilla.org/en-US/docs/Web/API/Performance/now

    DelayMinDelta = 60, DelayTolerance = 60,
    FrameIntervalMs = 16.67,
    // https://docs.microsoft.com/en-us/previous-versions/windows/it-pro/windows-2000-server/cc978658(v=technet.10)
    //            delay         interval  # delay - interval (not so useful)
    // high:  60f / 1000ms :  400ms / 24f # 660 / 28
    // low:   15f /  250ms :   33ms /  2f # 200 / 6

    AmountLimitToScrollAndWaitRepeatedKeys = 40,
    MinLatencyToAutoPreventHover = 20,
    DEBUG = 0,
}
interface ElementScrollInfo {
  /** area */ a: number;
  /** element */ e: SafeElement;
  /** height (cropped) */ h: number;
}

import {
  isAlive_, setupEventListener, timeout_, clearTimeout_, fgCache, doc, noRAF_old_cr_, readyState_, loc_, chromeVer_,
  vApi, deref_, weakRef_, VTr, createRegExp, max_, math, min_, Lower, OnChrome, OnFirefox, OnEdge, WithDialog, OnSafari,
  isTop, injector, isTY
} from "../lib/utils"
import {
  rAF_, scrollingEl_, SafeEl_not_ff_, docEl_unsafe_, NONE, frameElement_, OnDocLoaded_, GetParent_unsafe_, UNL,
  querySelector_unsafe_, getComputedStyle_, notSafe_not_ff_, HDN, isRawStyleVisible, fullscreenEl_unsafe_,
  doesSupportDialog, attr_s, getSelection_
} from "../lib/dom_utils"
import {
  scrollWndBy_, wndSize_, getZoom_, wdZoom_, bZoom_, isNotInViewport, prepareCrop_, padClientRect_, instantScOpt,
  getBoundingClientRect_, cropRectToVisible_, getVisibleClientRect_, dimSize_, scrollingTop, set_scrollingTop,
  isSelARange
} from "../lib/rect"
import {
  getParentVApi, resetSelectionToDocStart, checkHidden, addElementList, curModalElement, removeModal
} from "./dom_ui"
import { isCmdTriggered } from "./key_handler"
import { hint_box, tryNestedFrame } from "./link_hints"
import { setPreviousMarkPosition } from "./marks"
import { keyNames_, prevent_ } from "../lib/keyboard_utils"
import { post_, runFallbackKey } from "./port"

let toggleAnimation: ((scrolling?: BOOL | /** resume */ 2) => void) | null = null
let maxKeyInterval = 1
let minDelay: number
let currentScrolling: WeakRef<SafeElement> | null = null
let cachedScrollable: WeakRef<SafeElement> | 0 | null = 0
let keyIsDown = 0
let preventPointEvents: BOOL | 2 | ScrollConsts.MinLatencyToAutoPreventHover
let doesSucceed_: ReturnType<VApiTy["$"]>
let scale = 1
let joined: VApiTy | null | undefined
let scrolled: 0 | 1 | 2 = 0

export { currentScrolling, cachedScrollable, keyIsDown, scrolled }
export function set_scrolled (_newScrolled: 0): void { scrolled = _newScrolled }
export function set_currentScrolling (_newCurSc: WeakRef<SafeElement> | null): void { currentScrolling = _newCurSc }
export function set_cachedScrollable (_newCachedSc: typeof cachedScrollable): void { cachedScrollable = _newCachedSc }

let performAnimate = (newEl: SafeElement | null, newDi: ScrollByY, newAmount: number, nFs?: kScFlag & number): void => {
  let amount: number, sign: number, calibration: number, di: ScrollByY, duration: number, element: SafeElement | null,
  beforePos: number, timestamp: number, rawTimestamp: number, totalDelta: number, totalElapsed: number, min_delta = 0,
  running = 0, flags: kScFlag & number, timer: ValidTimeoutID = TimerID.None, calibTime: number, lostFrames: number,
  styleTop: SafeElement | null | undefined, onFinish: ((succeed: number) => void) | 0 | undefined,
  animate = (newRawTimestamp: number): void => {
    const continuous = keyIsDown > 0, rawElapsed = newRawTimestamp - rawTimestamp
    let newTimestamp = newRawTimestamp, elapsed: number
    // although timestamp is mono, Firefox adds too many limits to its precision
    if (!timestamp) {
      newTimestamp = performance.now()
      elapsed = max_(newRawTimestamp + (min_delta || ScrollConsts.firstTick) - newTimestamp, 0)
      newTimestamp = max_(newRawTimestamp, newTimestamp)
      beforePos = dimSize_(element, kDim.positionX + di)
    } else if (rawElapsed < 1e-5) {
      if (OnFirefox && rawElapsed > -1e-5) {
        elapsed = min_delta || ScrollConsts.tickForUnexpectedTime
        newTimestamp = timestamp + elapsed
      } else /** when (rawElapsed < -1e-5 || rawElapsed ~= 0 && VOther !== BrowserType.Firefox) */ {
        elapsed = 0
      }
    } else if (timer) {
      elapsed = min_delta; timer = TimerID.None
    } else {
      elapsed = newRawTimestamp > timestamp ? newRawTimestamp - timestamp : 0
      if (OnFirefox
          && rawElapsed > ScrollConsts.FirefoxMinFakeInterval - 1 && (rawElapsed === parseInt(<any> rawElapsed))) {
        if (elapsed > 1.5 * (min_delta || ScrollConsts.tickForUnexpectedTime)) {
          elapsed = min_delta || ScrollConsts.tickForUnexpectedTime
        }
        newTimestamp = timestamp + elapsed
      } else {
        if (preventPointEvents > ScrollConsts.MinLatencyToAutoPreventHover - 1 && rawElapsed > preventPointEvents
            && min_delta && rawElapsed > min_delta * 1.8 && ++lostFrames > 2) {
          preventPointEvents = 2
          toggleAnimation!(1)
        }
        if (rawTimestamp) {
          min_delta = !min_delta ? rawElapsed + 0.1
              : rawElapsed < min_delta + 2 ? (min_delta + rawElapsed) / 2 : (min_delta * 7 + rawElapsed) / 8
        }
      }
    }
    totalElapsed += elapsed
    if (!Build.NDEBUG && ScrollConsts.DEBUG & 1) {
      console.log("rawOld>rawNew: +%o = %o ; old>new: +%o = %o ; elapsed: +%o = %o; min_delta = %o"
          , (((newRawTimestamp - rawTimestamp) * 1e2) | 0) / 1e2
          , newRawTimestamp % 1e4 , (((newTimestamp - timestamp) * 1e2) | 0) / 1e2, newTimestamp % 1e4
          , ((elapsed * 1e2) | 0) / 1e2, ((totalElapsed * 1e2) | 0) / 1e2, ((min_delta * 1e2) | 0) / 1e2)
    }
    rawTimestamp = newRawTimestamp
    timestamp = newTimestamp
    if (!isAlive_ || !running) { toggleAnimation!(); return }
    if (continuous) {
      if (totalElapsed >= ScrollConsts.delayToChangeSpeed) {
        if (totalElapsed > minDelay) { keyIsDown = keyIsDown > elapsed ? keyIsDown - elapsed : 0 }
        calibTime += elapsed
        if (ScrollConsts.minCalibration <= calibration && calibration <= ScrollConsts.maxCalibration
            && calibTime > ScrollConsts.SpeedChangeInterval) {
          const calibrationScale = ScrollConsts.calibrationBoundary / amount / calibration;
          calibration *= calibrationScale > ScrollConsts.maxS ? ScrollConsts.maxS
            : calibrationScale < ScrollConsts.minS ? ScrollConsts.minS : 1;
          calibTime = 0
        }
      }
    }
    let delta = amount * (elapsed / duration) * calibration;
    if (!continuous || flags & kScFlag.TO && totalElapsed < minDelay) {
      delta = max_(0, min_(delta, amount - totalDelta))
    }
    // not use `sign * _performScroll()`, so that the code is safer even though there're bounce effects
    if (delta > 0) {
      const oldDelta = delta
      delta = performScroll(element, di, sign * math.ceil(delta), beforePos)
      if (!Build.NDEBUG && ScrollConsts.DEBUG & 2) {
        console.log("do scroll: %o + ceil(%o); effect=%o ; amount=%o ; keyIsDown=%o"
            , ((totalDelta * 100) | 0) / 100, ((oldDelta * 100) | 0) / 100, ((delta * 100) | 0) / 100, amount
            , ((keyIsDown * 10) | 0) / 10)
      }
      // if `scrollPageDown`, then amount is very large, but when it has been at page top/bottom,
      // `performScroll` will only return 0, then `delta || 1` is never enough.
      // In such cases stop directly
      beforePos += delta
      totalDelta += math.abs(delta)
    }
    if (delta && (!onFinish || totalDelta < amount)) {
      if (totalDelta >= amount && continuous && totalElapsed < minDelay - min_delta
          && (flags & kScFlag.TO || amount < ScrollConsts.AmountLimitToScrollAndWaitRepeatedKeys)) {
        running = 0
        timer = timeout_(/*#__NOINLINE__*/ resumeAnimation, minDelay - totalElapsed)
        if (!Build.NDEBUG && ScrollConsts.DEBUG) {
          console.log(">>> [animation] wait for %o - %o ms", minDelay, ((totalElapsed * 1e2) | 0) / 1e2)
        }
      } else {
        rAF_(animate)
      }
    } else if (elapsed) {
      if ((!OnChrome || chromeVer_ > BrowserVer.MinMaybeScrollEndAndOverScrollEvents - 1)
          && "onscrollend" in (OnFirefox ? doc : Image.prototype)) {
        // according to tests on C75, no "scrollend" events if scrolling behavior is "instant";
        // the doc on Google Docs requires no "overscroll" events for programmatic scrolling
        const notEl: boolean = !element || element === scrollingEl_();
        (notEl ? doc : element!).dispatchEvent(
            new Event("scrollend", {cancelable: false, bubbles: notEl}));
      }
      onFinish && onFinish(totalDelta)
      checkCurrent(element)
      toggleAnimation!();
    } else {
      rAF_(animate)
    }
  },
  hasDialog = OnChrome && Build.MinCVer >= BrowserVer.MinEnsuredHTMLDialogElement || WithDialog && doesSupportDialog(),
  resumeAnimation = (): void => {
    if (!keyIsDown) { toggleAnimation!(); return }
    flags & kScFlag.TO && amount > fgCache.t && (amount = min_(amount, dimSize_(element, di + kDim.viewW) / 2) | 0)
    totalElapsed = minDelay
    running = running || rAF_(animate);
  };
  toggleAnimation = (scrolling?: BOOL | 2): void => {
    if (scrolling === 2) { running || (clearTimeout_(timer), resumeAnimation()); return }
    if (!scrolling) {
      if (!Build.NDEBUG && ScrollConsts.DEBUG) {
        console.log(">>> [animation] stop after %o ms / %o px"
            , ((totalElapsed * 1e2) | 0) / 1e2, ((totalDelta * 1e2) | 0) / 1e2)
      }
      running = timestamp = rawTimestamp = beforePos = calibTime = preventPointEvents = lostFrames = 0
      element = null
    }
    if (WithDialog && (OnChrome && Build.MinCVer >= BrowserVer.MinEnsuredHTMLDialogElement || hasDialog)) {
      scrolling ? curModalElement || addElementList([], [0, 0], 1) : curModalElement !== hint_box && removeModal()
      return
    }
    const el = (scrolling ? OnFirefox ? docEl_unsafe_() : SafeEl_not_ff_!(docEl_unsafe_())
                : styleTop) as SafeElement & ElementToHTMLorOtherFormatted | null
    styleTop = scrolling ? el : null
    el && el.style ? el.style.pointerEvents = scrolling ? NONE : "" : 0;
  };
  performAnimate = (newEl1, newDi1, newAmount1, newFlags1): void => {
    amount = max_(1, newAmount1 > 0 ? newAmount1 : -newAmount1), calibration = 1.0, di = newDi1
    flags = newFlags1! | 0
    duration = max_(ScrollConsts.minDuration, ScrollConsts.durationScaleForAmount * math.log(amount))
    element = newEl1
    sign = newAmount1 < 0 ? -1 : 1
    timer && clearTimeout_(timer)
    timer = TimerID.None
    totalDelta = totalElapsed = 0.0
    timestamp = rawTimestamp = calibTime = lostFrames = onFinish = 0
    const keyboard = fgCache.k;
    keyboard.length > 2 && (min_delta = min_(min_delta, +keyboard[2]! || min_delta))
    maxKeyInterval = max_(min_delta, keyboard[1]) * 2 + ScrollConsts.DelayTolerance
    minDelay = keyboard[0] + max_(keyboard[1], ScrollConsts.DelayMinDelta) + ScrollConsts.DelayTolerance;
    (preventPointEvents === 2 || preventPointEvents === 1 && !isSelARange(getSelection_())) && toggleAnimation!(1)
    if (!Build.NDEBUG && ScrollConsts.DEBUG) {
      console.log("%c[animation]%c start with axis = %o, amount = %o, dir = %o, min_delta = %o"
          , "color: #1155cc", "color: auto", di ? "y" : "x", amount, sign, min_delta)
    }
    running = running || rAF_(animate)
    if (doesSucceed_ != null) {
      doesSucceed_ = new Promise((newResolve) => { onFinish = newResolve })
    }
  };
  performAnimate(newEl, newDi, newAmount, nFs)
}

const performScroll = ((el: SafeElement | null, di: ScrollByY, amount: number, before?: number): number => {
    before = before != null ? before : dimSize_(el, kDim.positionX + di)
    if (el) {
      (OnChrome ? Build.MinCVer >= BrowserVer.MinEnsuredCSS$ScrollBehavior : !OnEdge) ||
      // avoid using `Element`, so that users may override it
      el.scrollBy ? OnSafari ? el.scrollBy(di ? 0 : amount, di && amount) : el.scrollBy(instantScOpt(di, amount))
      : di ? el.scrollTop = before + amount : el.scrollLeft = before + amount
    } else {
      scrollWndBy_(di, amount)
    }
    return dimSize_(el, kDim.positionX + di) - before
}) as {
  (el: SafeElement | null, di: ScrollByY, amount: number, before?: number): number
}

/** should not use `scrollingTop` (including `dimSize_(scrollingTop, clientH/W)`) */
export const $sc: VApiTy["$"] = (element, di, amount, options): void => {
    if (hasSpecialScrollSnap(element)) {
      while (amount * amount >= 1 && !(doesSucceed_ = performScroll(element, di, amount))) {
        amount /= 2;
      }
      checkCurrent(element)
    } else if ((options && options.smooth != null ? options.smooth : fgCache.s)
        && !(OnChrome && Build.MinCVer <= BrowserVer.NoRAFOrRICOnSandboxedPage && noRAF_old_cr_)) {
      amount && performAnimate(element, di, amount, options && options.f)
      scrollTick(1)
    } else if (amount) {
      doesSucceed_ = performScroll(element, di, amount)
      checkCurrent(element)
    }
}

export const activate = (options: CmdOptions[kFgCmd.scroll] & SafeObject, count: number): void => {
    if (options.$c == null) {
      options.$c = isCmdTriggered
    }
    if (checkHidden(kFgCmd.scroll, options, count)) { return }
    if (tryNestedFrame(kFgCmd.scroll, options, count)) { return }
    const di: ScrollByY = options.axis === "x" ? 0 : 1, oriCount = count,
    dest = options.dest;
    let fromMax = dest === "max";
    if (dest) {
      if (count < 0) { fromMax = !fromMax; count = -count; }
      count--;
    } else {
      count *= +(options.dir!) || 1;
    }
    executeScroll(di, count, dest ? fromMax ? kScFlag.toMax : kScFlag.toMin : kScFlag.scBy as never
        , options.view as undefined, options, oriCount)
    if (keyIsDown && !options.$c) {
      scrollTick(0)
    }
}

  /**
   * @param amount0 can not be 0, if `isTo` is 0; can not be negative, if `isTo` is 1
   * @param factor `!!factor` can be true only if `isTo` is 0
   * @param fromMax can not be true, if `isTo` is 0
   */
export const executeScroll: VApiTy["c"] = function (di: ScrollByY, amount0: number, flags: kScFlag & number
      , factor?: NonNullable<CmdOptions[kFgCmd.scroll]["view"]> | undefined
      , options?: CmdOptions[kFgCmd.scroll], oriCount?: number): void {
    const toFlags = flags & (kScFlag.TO | kScFlag.INC), toMax = (toFlags - kScFlag.TO) as BOOL
    set_scrollingTop(scrollingEl_(1))
    if (scrollingTop) {
      getZoom_(1)
      getPixelScaleToScroll()
    }
    const element = findScrollable(di, toFlags ? toMax || -1 : amount0
        , options && (options.scroll ? options.scroll === "force"
            : options.evenIf != null ? !!(options.evenIf! & kHidden.OverflowHidden) : null))
    const isTopElement = element === scrollingTop
    const mayUpperFrame = !isTop && isTopElement && element && !fullscreenEl_unsafe_()
    let amount = !factor ?
        (!di && amount0 && element && dimSize_(element, kDim.scrollW)
            <= dimSize_(element, kDim.scrollH) * (dimSize_(element, kDim.scrollW) < 720 ? 2 : 1)
          ? amount0 * 0.6 : amount0) * fgCache.t
      : factor === 1 ? amount0
      : amount0 * dimSize_(element, di + (factor === "max" ? kDim.scrollW : kDim.viewW))
    if (toFlags) {
      const curPos = dimSize_(element, di + kDim.positionX),
      viewSize = dimSize_(element, di + kDim.viewW),
      rawMax = (toMax || amount) && dimSize_(element, di + kDim.scrollW),
      boundingMax = isTopElement && element ? getBoundingClientRect_(element).height : 0,
      max = (boundingMax > rawMax && boundingMax < rawMax + 1 ? boundingMax : rawMax) - viewSize
      const oldAmount = amount
      amount = max_(0, min_(toMax ? max - amount : amount, max)) - curPos
      amount = amount0 ? amount : toMax ? max_(amount, 0) : min_(amount, 0)
      if (!Build.NDEBUG && ScrollConsts.DEBUG & 8) {
        console.log("[scrollTo] cur=%o top_max=%o view=%o amount=%o, so final amount=%o", curPos, viewSize, max
            , oldAmount, amount)
      }
    }
    amount = amount * amount > 0.01 ? amount : 0
    let core: ReturnType<typeof getParentVApi>
    doesSucceed_ = null
    if (mayUpperFrame && (core = getParentVApi())
        && (!amount && !amount0 || Lower(attr_s(frameElement_()!, "scrolling") || "") === "no"
            || !doesScroll(element, di, amount || toMax))) {
        core.c(di, amount0, flags as 0, factor, options, oriCount)
        if (core.y().k) {
          scrollTick(1)
          joined = core
        }
        amount = 0;
    } else if (mayUpperFrame && options && !injector && !(options as OptionsWithForce).$forced
        && options.acrossFrames !== false
        && (!amount && !amount0 || !core && !doesScroll(element, di, amount || toMax))) {
      post_({ H: kFgReq.gotoMainFrame, f: 1, c: kFgCmd.scroll, n: oriCount!, a: options as OptionsWithForce })
      amount = 0
    } else if (options && (options.$then || options.$else)) {
      doesSucceed_ = 0
    }
    if (toFlags && isTopElement && amount) {
      di && setPreviousMarkPosition()
      if (!joined && options && (options as Extract<typeof options, {dest: string}>).sel === "clear") {
        resetSelectionToDocStart()
      }
    }
    set_scrollingTop(null)
    const keepHover = options && options.keepHover
    preventPointEvents = keepHover === !1 ? 1 : keepHover === "never" ? 2
        : keepHover === "auto" ? ScrollConsts.MinLatencyToAutoPreventHover
        : keepHover! > ScrollConsts.MinLatencyToAutoPreventHover - 1
        ? keepHover as ScrollConsts.MinLatencyToAutoPreventHover : 0
    ; ((options || (options = {} as { dest: "min" | "max" } as CmdOptions[kFgCmd.scroll])).f = flags)
    if (amount && readyState_ > "i" && overrideScrollRestoration) {
      overrideScrollRestoration("scrollRestoration", "manual")
    }
    const rawRet = vApi.$(element, di, amount, options),
    ret = amount ? rawRet != null ? rawRet : doesSucceed_ : doesSucceed_
    preventPointEvents = keyIsDown ? preventPointEvents : 0
    scrolled = doesSucceed_ = 0
    if (ret && isTY(ret, kTY.obj)) {
      ret.then((succeed): void => { runFallbackKey(options!, succeed ? 0 : 2) })
    } else if (ret != null) {
      runFallbackKey(options, ret ? 0 : 2)
    }
}

let overrideScrollRestoration = function (kScrollRestoration, kManual): void {
    const h = history, old = h[kScrollRestoration], listen = setupEventListener,
    reset = (): void => { h[kScrollRestoration] = old; listen(0, UNL, reset, 1); };
    if (old && old !== kManual) {
      h[kScrollRestoration] = kManual;
      overrideScrollRestoration = 0 as never
      OnDocLoaded_(() => { timeout_(reset, 1); }, 1);
      listen(0, UNL, reset);
    }
} as ((key: "scrollRestoration", kManual: "manual") => void) | 0

  /** @argument willContinue 1: continue; 0: skip middle steps; 2: abort further actions */
export const scrollTick = (willContinue: BOOL | 2): void => {
    if (!Build.NDEBUG && ScrollConsts.DEBUG & 4 && (keyIsDown || willContinue === 1)) {
      console.log("update keyIsDown from", ((keyIsDown * 10) | 0) / 10, "to", willContinue - 1 ? 0 : maxKeyInterval, "@"
          , ((performance.now() % 1e3 * 1e2) | 0) / 1e2)
    }
    keyIsDown = willContinue - 1 ? 0 : maxKeyInterval
    willContinue > 1 && toggleAnimation && toggleAnimation()
    if (joined) {
      joined.k(willContinue)
      if (willContinue - 1) {
        joined = null
      }
    }
}

export const beginScroll = (eventWrapper: 0 | Pick<HandlerNS.Event, "e">, key: string, keybody: kChar): void => {
    if (key.includes("s-") || key.includes("a-")) { return; }
    const index = keyNames_.indexOf(keybody) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8
    (index > 2 || key === keybody) && eventWrapper && prevent_(eventWrapper.e);
    if (index > 4) {
      executeScroll((~index & 1) as BOOL, index < 7 ? -1 : 1, kScFlag.scBy)
    } else if (index > 2) {
      executeScroll(1, 0, (6 - index) as 2 | 3 as kScFlag.toMin | kScFlag.toMax, 0)
    } else if (key === keybody) {
      executeScroll(1, index - 1.5, kScFlag.scBy, 2)
    }
}

export const onScrolls = (event: KeyboardEventToPrevent): boolean => {
    const repeat = OnChrome && Build.MinCVer < BrowserVer.Min$KeyboardEvent$$Repeat$ExistsButNotWork
        ? !!event.repeat : event.repeat
    repeat && prevent_(event);
    scrollTick(<BOOL> +repeat)
    repeat && toggleAnimation && toggleAnimation(2)
    return repeat;
}

  /**
   * @param amount should not be 0
   */
const findScrollable = (di: ScrollByY, amount: number
    , evenOverflowHidden?: boolean | 2 | null | undefined): SafeElement | null => {
  const selectFirst = (info: ElementScrollInfo, skipPrepare?: 1): ElementScrollInfo | null | undefined => {
    let cur_el = info.e, type: 0 | 1 | -1
    if (dimSize_(cur_el, kDim.elClientH) + 3 < dimSize_(cur_el, kDim.scrollH) &&
        (type = shouldScroll_s(cur_el, cur_el !== scrollingTop ? selectFirstType : 1, 1),
          type > 0 || !type && dimSize_(cur_el, kDim.positionY) > 0 && doesScroll(cur_el, kDim.byY, 0))) {
      return info
    }
    skipPrepare || prepareCrop_()
    let children: ElementScrollInfo[] = []
    for (let _ref = cur_el.children, _len = _ref.length; 0 < _len--; ) {
      cur_el = _ref[_len]! as /** fake `as` */ SafeElement
      // here assumes that a <form> won't be a main scrollable area
      if (!OnFirefox && notSafe_not_ff_!(cur_el)) { continue }
      const rect = padClientRect_(getBoundingClientRect_(cur_el))
      const visible = rect.b > rect.t ? cropRectToVisible_(rect.l, rect.t, rect.r, rect.b)
          : getVisibleClientRect_(cur_el)
      if (visible) {
        let height_ = visible.b - visible.t
        children.push({ a: (visible.r - visible.l) * height_, e: cur_el, h: height_})
      }
    }
    children.sort((a, b) => b.a - a.a)
    return children.reduce((cur, info1) => cur || selectFirst(info1, 1), null as ElementScrollInfo | null | undefined)
  }

    const top = scrollingTop, activeEl: SafeElement | null | undefined = deref_(currentScrolling)
    const selectFirstType = (evenOverflowHidden != null ? evenOverflowHidden : isTop || !!injector) ? 3 : 1
    let element = activeEl;
    if (element) {
      while (element !== top
          && shouldScroll_s(element!, element === cachedScrollable ? (di + 2) as 2 | 3 : di, amount) < 1) {
        element = (!OnFirefox
            ? SafeEl_not_ff_!(GetParent_unsafe_(element!, PNType.RevealSlotAndGotoParent))
            : GetParent_unsafe_(element!, PNType.RevealSlotAndGotoParent) as SafeElement | null
          ) || top;
      }
      element = element !== top ? element : null
      cachedScrollable = weakRef_(element)
    }
    if (!element) {
      // note: twitter auto focuses its dialog panel, so it's not needed to detect it here
      const candidate = createRegExp(kTip.redditHost, "").test(loc_.host)
          ? querySelector_unsafe_(VTr(kTip.redditOverlay)) : null;
      element = OnFirefox ? candidate as SafeElement | null : SafeEl_not_ff_!(candidate)
    }
    if (!element && top) {
      const candidate = selectFirst({ a: 0, e: top, h: 0 })
      element = candidate && candidate.e !== top
          && (!activeEl || candidate.h > wndSize_() / 2)
          ? candidate.e : top;
      // if current_, then delay update to current_, until scrolling ends and ._checkCurrent is called;
      // otherwise, cache selected element for less further cost
      activeEl || (currentScrolling = weakRef_(element), cachedScrollable = 0);
    }
    return element;
}

export const getPixelScaleToScroll = (): void => {
    /** https://drafts.csswg.org/cssom-view/#dom-element-scrolltop
     * Imported on 2013-05-15 by https://github.com/w3c/csswg-drafts/commit/ad01664359641f791d99f0b3fce545b55579acdc
     * Firefox is still using `int`: https://bugzilla.mozilla.org/show_bug.cgi?id=1217330 (filed on 2015-10-22)
     */
  scale = (OnFirefox ? 2 : 1) / min_(1, wdZoom_) / min_(1, bZoom_)
}

const checkCurrent = (el: SafeElement | null): void => {
  let cur = deref_(currentScrolling)
  if (cur ? cur !== el && isNotInViewport(cur) : currentScrolling) {
    currentScrolling = weakRef_(el), cachedScrollable = 0
  }
}

const hasSpecialScrollSnap = (el: SafeElement | null): boolean | string | null | undefined => {
    const scrollSnap: string | null | undefined = el && getComputedStyle_(el).scrollSnapType;
    return scrollSnap !== NONE && scrollSnap;
}

const doesScroll = (el: SafeElement, di: ScrollByY, amount: number): boolean => {
    /** @todo: re-check whether it's scrollable when hasSpecialScrollSnap_ on Firefox */
    // Currently, Firefox corrects positions before .scrollBy returns,
    // so it always fails if amount < next-box-size
    const before = dimSize_(el, di + kDim.positionX),
    changed = performScroll(el, di, (amount > 0 ? 1 : -1) * scale, before)
    if (changed) {
      if (!di && hasSpecialScrollSnap(el)) {
        /**
         * Here needs the third scrolling, because in `X Prox. LTR` mode, a second scrolling may jump very far.
         * Tested on https://developer.mozilla.org/en-US/docs/Web/CSS/scroll-snap-type .
         */
        let changed2 = performScroll(el, 0, -changed, before)
        changed2 * changed2 > 0.1 && performScroll(el, 0, -changed2, before)
      } else if ((OnChrome ? Build.MinCVer >= BrowserVer.MinEnsuredCSS$ScrollBehavior : !OnEdge) || el.scrollTo) {
        OnSafari ? el.scrollTo(di ? 0 : before, di && before) : el.scrollTo(instantScOpt(di, before))
      } else {
        di ? (el.scrollTop = before) : (el.scrollLeft = before);
      }
      scrolled = scrolled || 1
    }
    return !!changed;
}

export const scrollIntoView_s = (el?: SafeElement | null): void => {
    const rect = el && el.getClientRects()[0] as ClientRect | undefined
    if (!rect) { return; }
    let r = padClientRect_(rect), iw = wndSize_(1), ih = wndSize_(),
    ihm = min_(96, ih / 2), iwm = min_(64, iw / 2),
    hasY = r.b < ihm ? max_(r.b - ih + ihm, r.t - ihm) : ih < r.t + ihm ? min_(r.b - ih + ihm, r.t - ihm) : 0,
    hasX = r.r < 0 ? max_(r.l - iwm, r.r - iw + iwm) : iw < r.l ? min_(r.r - iw + iwm, r.l - iwm) : 0
    currentScrolling = weakRef_(el!)
    cachedScrollable = 0
    if (hasX || hasY) {
      for (let el2: Element | null = el!; el2; el2 = GetParent_unsafe_(el2, PNType.RevealSlotAndGotoParent)) {
        const pos = getComputedStyle_(el2).position;
        if (pos === "fixed" || pos === "sticky") {
          hasX = hasY = 0;
          break;
        }
      }
      if (hasX) {
        doesSucceed_ = null;
        (hasY ? performScroll : vApi.$)(findScrollable(0, hasX), 0, hasX);
      }
      if (hasY) {
        doesSucceed_ = null
        vApi.$(findScrollable(1, hasY), 1, hasY)
      }
    }
    scrolled = doesSucceed_ = 0
    scrollTick(0); // it's safe to only clean keyIsDown here
}

export const shouldScroll_s = (element: SafeElement, di: BOOL | 2 | 3, amount: number): -1 | 0 | 1 => {
    const st = getComputedStyle_(element), overflow = di ? st.overflowY : st.overflowX
    return (overflow === HDN && di < 2 || overflow === "clip")
      || st.display === NONE || !isRawStyleVisible(st) ? -1
      : <BOOL> +doesScroll(element, (di & 1) as BOOL, amount || +!dimSize_(element, kDim.positionX + di))
}

export const suppressScroll = (): void => {
    if (OnChrome && Build.MinCVer <= BrowserVer.NoRAFOrRICOnSandboxedPage && noRAF_old_cr_) {
      scrolled = 0
      return;
    }
    scrolled = 2
    setupEventListener(0, "scroll");
    rAF_(function (): void {
      scrolled = 0
      setupEventListener(0, "scroll", null, 1);
    });
}

export const onActivate = (event: Event): void => {
  if (!OnChrome || Build.MinCVer >= BrowserVer.Min$Event$$IsTrusted ? event.isTrusted : event.isTrusted !== false) {
    const path = !OnEdge && (!OnChrome
          || Build.MinCVer >= BrowserVer.Min$Event$$composedPath$ExistAndIncludeWindowAndElementsIfListenedOnWindow)
        ? event.composedPath!() : event.path,
    el = !OnEdge && (!OnChrome
              || Build.MinCVer >= BrowserVer.MinOnFocus$Event$$Path$IncludeOuterElementsIfTargetInClosedShadowDOM
              || Build.MinCVer >= BrowserVer.Min$Event$$Path$IncludeWindowAndElementsIfListenedOnWindow)
        || (OnEdge || Build.MinCVer >= BrowserVer.MinEnsured$Event$$Path || path) && path!.length > 1
        ? path![0] as Element : event.target as Element;
    currentScrolling = weakRef_(OnFirefox ? el as SafeElement | null : SafeEl_not_ff_!(el))
    cachedScrollable = 0
  }
}
