import {
  findCSS_, innerCSS_, omniPayload_, set_findCSS_, set_innerCSS_, CurCVer_, CurFFVer_, IsEdg_, omniStyleOverridden_,
  OnChrome, OnEdge, OnFirefox, isHighContrast_ff_, set_isHighContrast_ff_, bgIniting_, CONST_, set_helpDialogData_,
  framesForOmni_, settingsCache_, set_omniStyleOverridden_
} from "./store"
import { asyncIter_, fetchFile_, spacesRe_ } from "./utils"
import { broadcastOmni_, get_, postUpdate_, storage_, updateHooks_ } from "./settings"
import { asyncIterFrames_ } from "./ports"

declare const enum MergeAction {
  virtual = -1, readFromCache = 0, rebuildWhenInit = 1, rebuildAndBroadcast = 2,
  saveOption = "userDefinedCss",
}

interface ParsedSections {
  ui?: string; find?: string; "find:host"?: string; omni?: string
}

const StyleCacheId_ = CONST_.VerCode_ + ","
    + (OnChrome ? CurCVer_ : OnFirefox ? CurFFVer_ : 0)
    + ( !OnEdge && (!OnChrome || Build.MinCVer >= BrowserVer.MinShadowDOMV0)
          && (!OnFirefox || Build.MinFFVer >= FirefoxBrowserVer.MinEnsuredShadowDOMV1)
        ? ""
        : (OnChrome && Build.MinCVer < BrowserVer.MinEnsuredUnprefixedShadowDOMV0
            ? globalThis.ShadowRoot || document.body!.webkitCreateShadowRoot : globalThis.ShadowRoot)
        ? "s" : "")
    + (OnChrome && Build.MinCVer >= BrowserVer.MinUsableCSS$All ? ""
      : (!OnChrome || CurCVer_ > BrowserVer.MinUsableCSS$All - 1)
        && (!OnEdge || "all" in (document.body as HTMLElement).style)
      ? "a" : "")
    + ";"

export const reloadCSS_ = (action: MergeAction, cssStr?: string): SettingsNS.MergedCustomCSS | void => {
  if (action === MergeAction.virtual) {
    return mergeCSS(cssStr!, MergeAction.virtual)
  }
  if (action === MergeAction.rebuildAndBroadcast) { set_helpDialogData_(null) }
  {
    let findCSSStr: string | null | false
    if (findCSSStr = action === MergeAction.readFromCache && storage_.getItem("findCSS")) {
      // Note: The lines below are allowed as a special use case
      set_findCSS_(parseFindCSS_(findCSSStr))
      set_innerCSS_(cssStr!.slice(StyleCacheId_.length))
      omniPayload_.c = storage_.getItem("omniCSS") || ""
      return
    }
  }
  fetchFile_(CONST_.baseCSS).then((css: string): void => {
    const browserInfo = StyleCacheId_.slice(StyleCacheId_.indexOf(",") + 1),
    hasAll = OnChrome && Build.MinCVer >= BrowserVer.MinUsableCSS$All || browserInfo.includes("a")
    if (!(Build.NDEBUG || css.startsWith(":host{"))) {
      console.log('Assert error: `css.startsWith(":host{")` in settings.updateHooks_.baseCSS')
    }
    if (!Build.NDEBUG) {
      css = css.replace(<RegExpG> /\r\n?/g, "\n")
    }
    if (OnFirefox && Build.MinFFVer < FirefoxBrowserVer.MinUnprefixedUserSelect
        ? CurFFVer_ < FirefoxBrowserVer.MinUnprefixedUserSelect
        : OnChrome && Build.MinCVer < BrowserVer.MinUnprefixedUserSelect
          && CurCVer_ < BrowserVer.MinUnprefixedUserSelect) {
      // on Firefox, the `-webkit` prefix is in the control of `layout.css.prefixes.webkit`
      css = css.replace(<RegExpG> /user-select\b/g, OnFirefox ? "-moz-$&" : "-webkit-$&")
    }
    if (OnEdge || OnChrome && Build.MinCVer < BrowserVer.MinCSS$Color$$RRGGBBAA
        && CurCVer_ < BrowserVer.MinCSS$Color$$RRGGBBAA) {
      css = css.replace(<RegExpG & RegExpSearchable<0>> /#[\da-f]{4}([\da-f]{4})?\b/gi, (s: string): string => {
        s = s.length === 5 ? "#" + s[1] + s[1] + s[2] + s[2] + s[3] + s[3] + s[4] + s[4] : s
        const color = parseInt(s.slice(1), 16),
        r = color >>> 24, g = (color >> 16) & 0xff, b = (color >> 8) & 0xff, alpha = (color & 0xff) / 255 + ""
        return `rgba(${r},${g},${b},${alpha.slice(0, 4)})`
      })
    }
    const cssFile = parseSections_(css)
    let isHighContrast_ff = false, hcChanged_ff = false
    if (OnFirefox) {
      if (!matchMedia("(forced-colors)").matches) {
        isHighContrast_ff = storage_.getItem(GlobalConsts.kIsHighContrast) === "1"
      }
      hcChanged_ff = isHighContrast_ff_ !== isHighContrast_ff
      set_isHighContrast_ff_(isHighContrast_ff)
    }
    css = cssFile.ui!
    if (hasAll) {
      // Note: must not move "all:" into ":host" even when "s" and >= MinSelector$deep$InDynamicCssMeansNothing
      // in case that ":host" is set [style="all:unset"]
      const ind2 = css.indexOf("all:"), ind1 = css.lastIndexOf("{", ind2),
      ind3 = !OnChrome || Build.MinCVer >= BrowserVer.MinEnsuredSafeInnerCSS
          || CurCVer_ >= BrowserVer.MinEnsuredSafeInnerCSS ? css.indexOf(";", ind2) : css.length
      css = css.slice(0, ind1 + 1) + css.slice(ind2, ind3 + 1)
          + css.slice(css.indexOf("\n", ind3) + 1 || css.length)
    } else {
      css = css.replace(<RegExpOne> /all:\s?\w+;?/, "")
    }
    if ((!OnChrome || Build.MinCVer >= BrowserVer.MinEnsuredDisplayContents
          || CurCVer_ > BrowserVer.MinEnsuredDisplayContents - 1)
        && !OnEdge) {
      const ind2 = css.indexOf("display:"), ind1 = css.lastIndexOf("{", ind2)
      css = css.slice(0, ind1 + 1) + css.slice(ind2)
    } else {
      css = css.replace("contents", "block")
    }
    if (OnChrome && Build.MinCVer < BrowserVer.MinSpecCompliantShadowBlurRadius
        && CurCVer_ < BrowserVer.MinSpecCompliantShadowBlurRadius) {
      css = css.replace("3px 5px", "3px 7px")
    }
    if (!OnChrome || (Build.MinCVer < BrowserVer.MinAbsolutePositionNotCauseScrollbar
            && CurCVer_ < BrowserVer.MinAbsolutePositionNotCauseScrollbar)) {
      css = css.replace(".LH{", ".LH{box-sizing:border-box;")
    }
    if (OnFirefox) {
      const ind1 = css.indexOf(".LH{") + 4, ind2 = css.indexOf("}", ind1)
      let items = css.slice(ind1, ind2).replace("2.5px 3px 2px", "3px").replace("0.5px", "1px")
      css = css.slice(0, ind1) + items + css.slice(ind2)
    }
    if (OnFirefox && isHighContrast_ff) {
      css = css.replace(<RegExpOne> /\n\.D[^@]+/, "").replace("@media(forced-colors:active){", "").slice(0, -1)
    } else if (OnChrome && Build.MinCVer < BrowserVer.MinForcedColorsMode
        && IsEdg_ && CurCVer_ < BrowserVer.MinForcedColorsMode) {
      css = css.replace("forced-colors", "-ms-high-contrast")
    }
    if (!((!OnChrome || Build.MinCVer >= BrowserVer.MinShadowDOMV0)
          && (!OnFirefox || Build.MinFFVer >= FirefoxBrowserVer.MinEnsuredShadowDOMV1)
          && !OnEdge)
        && !browserInfo.includes("s")) {
      /** Note: {@link ../front/vimium-c.css}: this requires `:host{` is at the beginning */
      const hostEnd = css.indexOf("}") + 1, secondEnd = css.indexOf("}", hostEnd) + 1,
      prefix = "#VimiumUI"
      let body = css.slice(secondEnd)
      if (hasAll) {
        body = body.replace(<RegExpG> /\b[IL]H\s?\{/g, "$&all:inherit;")
      }
      body += `${prefix}::before,${prefix}::after,.R::before,.R:not(.HUD)::after{display:none!important}`
      css = prefix + css.slice(5, hostEnd) +
          /** Note: {@link ../front/vimium-c.css}: this requires no ID/attr selectors in "ui" styles */
          body.replace(<RegExpG> /\.[A-Z][^,{]*/g, prefix + " $&")
    }
    css = css.replace(<RegExpG> /\n/g, "")
    if (OnChrome && Build.MinCVer < BrowserVer.MinBorderWidth$Ensure1$Or$Floor
        && CurCVer_ < BrowserVer.MinBorderWidth$Ensure1$Or$Floor) {
      const defaultWidth = Build.MinCVer < BrowserVer.MinEnsuredBorderWidthWithoutDeviceInfo
          && CurCVer_ < BrowserVer.MinEnsuredBorderWidthWithoutDeviceInfo ? 1 : 0.5
      css = css.replace(<RegExpG> /0\.01|\/\*!DPI\*\/ ?[\d.]+/g, "/*!DPI*/" + defaultWidth)
    }
    if (OnFirefox) { /** {@link ../tests/dom/firefox-position_fixed-in-dialog.html} */
      css += ".DLG>.Omnibar{position:absolute}"
    }
    storage_.setItem("innerCSS", StyleCacheId_ + css)
    let findCSS = cssFile.find!
    storage_.setItem("findCSS", findCSS.length + "\n" + findCSS)
    if (OnFirefox && hcChanged_ff && bgIniting_ === BackendHandlersNS.kInitStat.FINISHED) {
      postUpdate_("vomnibarOptions")
    }
    mergeCSS(get_("userDefinedCss"), action)
  })
}

const parseSections_ = (css: string): ParsedSections => {
  const arr = css ? css.split(<RegExpG & RegExpSearchable<1>> /^\/\*\s?#!?([A-Za-z:]+)\s?\*\//m) : [""]
  const sections: ParsedSections = { ui: arr[0].trim() }
  for (let i = 1; i < arr.length; i += 2) {
    let key = arr[i].toLowerCase() as "ui" | "find" | "find:host" | "omni"
    sections[key] = (sections[key] || "") + arr[i + 1].trim()
  }
  return sections
}

const parseFindCSS_ = (find2: string): FindCSS => {
  find2 = find2.slice(find2.indexOf("\n") + 1)
  let idx = find2.indexOf("\n") + 1, endFH = find2.indexOf("\n", idx)
  return { c: find2.slice(0, idx - 1), s: find2.slice(idx, endFH).replace("  ", "\n"),
    i: find2.slice(endFH + 1) }
}

const mergeCSS = (css2Str: string, action: MergeAction | "userDefinedCss"): SettingsNS.MergedCustomCSS | void => {
  let css = storage_.getItem("innerCSS")!, idx = css.indexOf("\n")
  css = idx > 0 ? css.slice(0, idx) : css
  const css2 = parseSections_(css2Str)
  let newInnerCSS = css2.ui ? css + "\n" + css2.ui : css
  let findh = css2["find:host"], find2 = css2.find, omni2 = css2.omni, F = "findCSS", O = "omniCSS"
  css = storage_.getItem(F)!
  idx = css.indexOf("\n")
  css = css.slice(0, idx + 1 + +css.slice(0, idx))
  let endFH = css.indexOf("\n", css.indexOf("\n", idx + 1) + 1), offsetFH = css.lastIndexOf("  ", endFH)
  findh = findh ? "  " + findh.replace(<RegExpG> /\n/g, " ") : ""
  if (offsetFH > 0 ? css.slice(offsetFH, endFH) !== findh : findh) {
    css = css.slice(idx + 1, offsetFH > 0 ? offsetFH : endFH) + findh + css.slice(endFH)
    css = css.length + "\n" + css
  }
  find2 = find2 ? css + "\n" + find2 : css
  css = (storage_.getItem(O) || "").split("\n", 1)[0]
  omni2 = omni2 ? css + "\n" + omni2 : css
  if (action === MergeAction.virtual) {
    return { ui: newInnerCSS.slice(StyleCacheId_.length), find: parseFindCSS_(find2), omni: omni2 }
  }

  storage_.setItem("innerCSS", newInnerCSS)
  storage_.setItem(F, find2)
  omni2 ? storage_.setItem(O, omni2) : storage_.removeItem(O)
  reloadCSS_(MergeAction.readFromCache, newInnerCSS)
  if (action !== MergeAction.readFromCache && action !== MergeAction.rebuildWhenInit) {
    asyncIterFrames_((frames: Frames.Frames): void => {
        for (const port of frames.ports_) {
          const flags = port.s.flags_
          if (port.s.flags_ & Frames.Flags.hasCSS) {
            port.postMessage({
              N: kBgReq.showHUD, H: innerCSS_, f: flags & Frames.Flags.hasFindCSS ? findCSS_ : void 0
            })
          }
        }
    })
    broadcastOmni_({ N: kBgReq.omni_updateOptions, d: { c: omniPayload_.c } })
  }
}

export const setOmniStyle_ = (req: FgReq[kFgReq.setOmniStyle], port?: Port): void => {
  let styles: string, curStyles = omniPayload_.s
  if (!req.o && omniStyleOverridden_) {
    return
  }
  {
    let toggled = ` ${req.t} `, extSt = curStyles && ` ${curStyles} `, exists = extSt.includes(toggled),
    newExist = req.e != null ? req.e : exists
    styles = newExist ? exists ? curStyles : curStyles + toggled : extSt.replace(toggled, " ")
    styles = styles.trim().replace(spacesRe_, " ")
    if (req.b === false) { omniPayload_.s = styles; return }
    if (req.o) {
      set_omniStyleOverridden_(newExist !== (` ${settingsCache_.vomnibarOptions.styles} `.includes(toggled)))
    }
  }
  if (styles === curStyles) { return }
  omniPayload_.s = styles
  const request2: Req.bg<kBgReq.omni_updateOptions> = { N: kBgReq.omni_updateOptions, d: { s: styles } }
  asyncIter_(framesForOmni_.slice(0), (frame): number => {
    frame !== port && framesForOmni_.includes!(frame) && frame.postMessage(request2)
    return 1
  })
}

updateHooks_.userDefinedCss = mergeCSS

set_innerCSS_(storage_.getItem("innerCSS") || "")
if (innerCSS_ && !innerCSS_.startsWith(StyleCacheId_)) {
  storage_.removeItem("vomnibarPage_f")
  reloadCSS_(MergeAction.rebuildWhenInit, innerCSS_)
} else {
  reloadCSS_(MergeAction.readFromCache, innerCSS_)
}
