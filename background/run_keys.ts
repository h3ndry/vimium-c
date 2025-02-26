import {
  framesForTab_, get_cOptions, cPort, cRepeat, set_cPort, cKey, curTabId_, keyToCommandMap_, get_cEnv, set_cEnv, set_cKey, set_cOptions, set_runOneMapping_
} from "./store"
import * as BgUtils_ from "./utils"
import { runtimeError_, getCurWnd } from "./browser"
import { getPortUrl_, safePost, showHUD } from "./ports"
import { createSimpleUrlMatcher_, matchSimply_ } from "./exclusions"
import { trans_ } from "./i18n"
import {
  normalizedOptions_, envRegistry_, parseOptions_, normalizeCommand_, availableCommands_, makeCommand_
} from "./key_mappings"
import {
  copyCmdOptions, executeCommand, overrideOption, parseFallbackOptions, replaceCmdOptions, runNextCmdBy
} from "./run_commands"
import C = kBgCmd
import NormalizedEnvCond = CommandsNS.NormalizedEnvCond

declare const enum kStr { RunKeyWithId = "<v-runkey:$1>" }
const abs = Math.abs
let loopIdToRunSeq = 0

const collectOptions = (opts: { [key: `o.${string}`]: any }): CommandsNS.Options | null => {
  const o2 = BgUtils_.safeObj_<any>()
  let found = ""
  for (const key in opts) {
    if (key.startsWith("o.") && key.length > 2 && !key.includes("$")) {
      o2[found = key.slice(2)] = opts[key as `o.${string}`]
    }
  }
  return found ? o2 : null
}

//#region execute a command when in a special environment

declare const enum EnvMatchResult { abort, nextEnv, matched }

const matchEnvRule = (rule: CommandsNS.EnvItem, info: CurrentEnvCache): EnvMatchResult => {
  // avoid sending messages to content scripts - in case a current tab is running slow
  let host = rule.host, iframe = rule.iframe, fullscreen = rule.fullscreen, elSelector = rule.element
  if (host === undefined) {
    host = rule.host = rule.url != null ? rule.url : null
    delete rule.url
  }
  if (typeof host === "string") {
    host = rule.host = createSimpleUrlMatcher_(host)
  }
  if (host != null) {
    let url: string | null | undefined | Promise<string> = info.url, slash: number
    if (url == null && host.t === kMatchUrl.StringPrefix
        && ((slash = host.v.indexOf("/", host.v.indexOf("://") + 3)) === host.v.length - 1 || slash === -1)) {
      const port = framesForTab_.get(cPort ? cPort.s.tabId_ : curTabId_)?.top_ || cPort
      url = port ? port.s.url_ : null
    }
    if (url == null && (url = getPortUrl_(null, true)) instanceof Promise) {
      void url.then((s): void => {
        info.url = s || (cPort ? (framesForTab_.get(cPort.s.tabId_)?.top_ || cPort).s.url_
            : /** should not reach here */ "")
        runKeyWithCond(info)
      })
      return EnvMatchResult.abort
    }
    if (!matchSimply_(host, url)) { return EnvMatchResult.nextEnv }
  }
  if (iframe != null) {
    if (!cPort && iframe !== false) { return EnvMatchResult.nextEnv }
    if (typeof iframe === "string") {
      iframe = rule.iframe = createSimpleUrlMatcher_(iframe) || true
    }
    if (typeof iframe === "boolean") {
      if (iframe !== !!(cPort && cPort.s.frameId_)) { return EnvMatchResult.nextEnv }
    } else if (!matchSimply_(iframe, cPort.s.url_)) {
      return EnvMatchResult.nextEnv
    }
  }
  if (fullscreen == null) { /* empty */ }
  else if (info.fullscreen == null) {
    getCurWnd(false, (wnd): void => {
      info.fullscreen = !!wnd && wnd.state.includes("fullscreen")
      runKeyWithCond(info)
      return runtimeError_()
    })
    return EnvMatchResult.abort
  } else if (!!fullscreen !== info.fullscreen) {
    return EnvMatchResult.nextEnv
  }
  if (elSelector && elSelector !== "*") {
    const selectorArr = typeof elSelector === "string" ? [] : elSelector
    typeof elSelector === "string" && (rule.element = elSelector.split(",").some((s): boolean => {
      s = s[0] === "*" ? s.slice(1) : s
      const hash = s.indexOf("#"), dot = s.indexOf("."), len = s.length
      s && selectorArr.push({
        tag: s.slice(0, hash < 0 ? dot < 0 ? len : dot : dot < 0 ? hash : Math.min(dot, hash)),
        id: hash >= 0 ? s.slice(hash + 1, dot > hash ? dot : len) : "",
        classList: BgUtils_.normalizeClassesToMatch_(dot >= 0 ? s.slice(dot + 1, hash > dot ? hash : len) : "")
      })
      return s === "*" || s.includes(" ")
    }) ? (selectorArr.length = 0, "*") : selectorArr)
    const cur = info.element
    if (!selectorArr.length) { /* empty */ }
    else if (cur == null) {
      cPort && safePost(cPort, { N: kBgReq.queryForRunKey, n: performance.now(), c: info })
      return cPort ? EnvMatchResult.abort : EnvMatchResult.nextEnv
    } else if (! selectorArr.some((s): any => cur === 0 ? s.tag === "body" && !s.id && !s.classList :
        (!s.tag || cur[0] === s.tag) && (!s.id || cur[1] === s.id)
        && (!s.classList.length || cur[2].length > 0 && s.classList.every(i => cur[2].includes!(i)))
    )) {
      return EnvMatchResult.nextEnv
    }
  }
  return EnvMatchResult.matched
}

const normalizeExpects = (options: KnownOptions<C.runKey>): (NormalizedEnvCond | null)[] => {
  const expected_rules = options.expect
  if (options.$normalized) { return expected_rules as NormalizedEnvCond[] }
  const normalizeKeys = (keys: string | string[] | null | undefined): string[] => {
    return keys ? typeof keys === "string" ? keys.trim().split(<RegExpG> /[, ]+/)
        : keys instanceof Array ? keys : [] : []
  }
  let new_rules: (NormalizedEnvCond | null)[] = []
  if (!expected_rules) { /* empty */ }
  else if (expected_rules instanceof Array) {
    new_rules = expected_rules.map((rule): NormalizedEnvCond | null => rule instanceof Array
        ? { env: rule[0], keys: normalizeKeys(rule[1]), options: rule[2] as any }
        : !rule || typeof rule !== "object" ? null
        : { env: rule.env || rule, keys: normalizeKeys(rule.keys), options: rule.options })
  } else if (typeof expected_rules === "object") {
    new_rules = Object.keys(expected_rules).map((name): NormalizedEnvCond => {
      const val = expected_rules[name], isDict = val && typeof val === "object" && !(val instanceof Array)
      return { env: name, keys: normalizeKeys(isDict ? val.keys : val), options: isDict ? val.options : null }
    })
  } else if (typeof expected_rules === "string" && (<RegExpOne> /^[^{].*?[:=]/).test(expected_rules)) {
    const delimiterRe = expected_rules.includes(":") ? <RegExpOne> /:/ : <RegExpOne> /=/
    new_rules = expected_rules.split(expected_rules.includes(";") ? <RegExpG> /[;\s]+/g : <RegExpG> /[,\s]+/g)
        .map(i => i.split(delimiterRe))
        .map((rule): NormalizedEnvCond | null => rule.length !== 2 ? null
              : ({ env: rule[0], keys: normalizeKeys(rule[1]), options: null }))
  }
  new_rules = new_rules.map((i): NormalizedEnvCond | null =>
        i && i.env && i.env !== "__proto__" && i.keys.length ? i : null)
  overrideOption<C.runKey, "expect">("expect", new_rules, options)
  overrideOption<C.runKey, "keys">("keys", normalizeKeys(options.keys), options)
  overrideOption<C.runKey, "$normalized">("$normalized", true, options)
  return new_rules
}

/** not call runNextCmd on invalid env/key info, but just show HUD to alert */
export const runKeyWithCond = (info?: CurrentEnvCache): void => {
  const absCRepeat = abs(cRepeat)
  let matched: NormalizedEnvCond | undefined
  const frames = framesForTab_.get(cPort ? cPort.s.tabId_ : curTabId_)
  if (!cPort) {
    set_cPort(frames ? frames.cur_ : null as never)
  }
  info = info || get_cEnv() || {}
  set_cEnv(null)
  const expected_rules = normalizeExpects(get_cOptions<C.runKey, true>())
  for (const normalizedRule of expected_rules) {
    if (!normalizedRule) { continue }
    const ruleName = normalizedRule.env
    let rule: CommandsNS.EnvItem | string | null | undefined = ruleName
    if (typeof rule === "string") {
      if (!envRegistry_) {
        showHUD("No environments have been declared")
        return
      }
      rule = envRegistry_.get(rule)
      if (rule === undefined) {
        showHUD(`No environment named "${ruleName}"`)
        return
      }
      if (typeof rule === "string") {
        rule = parseOptions_(rule, 2) as CommandsNS.EnvItem | null
        envRegistry_.set(ruleName as string, rule)
      }
      if (rule === null) { continue }
    }
    const res = matchEnvRule(rule, info)
    if (res === EnvMatchResult.abort) { return }
    if (res === EnvMatchResult.matched) {
      matched = normalizedRule
      break
    }
  }
  interface SingleSequence { tree: ListNode | ErrorNode; options: CommandsNS.RawOptions | null }
  const keys = (matched ? matched.keys : get_cOptions<C.runKey, true>().keys) as (string | SingleSequence)[]
  let seq: string | SingleSequence, key: string | ListNode | ErrorNode, keysInd: number
  const sub_name = matched ? typeof matched.env === "string" ? `[${matched.env}]: `
      : `(${expected_rules.indexOf(matched)})` : ""
  if (keys.length === 0) {
    showHUD(sub_name + "Require keys: comma-seperated-string | string[]")
  } else if (absCRepeat > keys.length && keys.length !== 1) {
    showHUD(sub_name + "Has no such a key")
  } else if (seq = keys[keysInd = keys.length === 1 ? 0 : cRepeat > 0 ? absCRepeat - 1 : keys.length - absCRepeat],
      !seq || typeof seq !== "string" && (typeof seq !== "object"
        || !seq.tree || typeof seq.tree !== "object" || typeof seq.tree.t !== "number")) {
    showHUD(sub_name + "The key is invalid")
  } else {
    const repeat = keys.length === 1 ? cRepeat : 1
    let options = matched && matched.options || get_cOptions<C.runKey, true>().options
        || collectOptions(get_cOptions<C.runKey, true>())
    let options2: CommandsNS.RawOptions | null
    if (typeof seq === "string") {
      const optionsPrefix = seq.startsWith("#") ? seq.split("+", 1)[0] : ""
      options2 = optionsPrefix.length > 1 ? parseEmbeddedOptions(optionsPrefix.slice(1)) : null
      key = parseKeySeq(seq.slice(optionsPrefix ? optionsPrefix.length + 1 : 0))
      seq = keys[keysInd] = { tree: key, options: options2 }
    } else {
      key = seq.tree, options2 = seq.options
    }
    options = !options2 || !options ? options || options2
        : copyCmdOptions(copyCmdOptions(BgUtils_.safeObj_(), options2), options as CommandsNS.Options)
    if (key.t === kN.error) { showHUD(key.val); return }
    else if ((As_<ListNode>(key)).val.length === 0) { return }
    const newIntId = loopIdToRunSeq = (loopIdToRunSeq + 1) % 64 || 1
    const seqId = kStr.RunKeyWithId.replace("$1", "" + newIntId as "1")
    if (key.val.length > 1 || key.val[0].t !== kN.key) {
      const fakeOptions: KnownOptions<C.runKey> = {
        $seq: { keys: key, repeat, options, cursor: key, timeout: 0, id: seqId,
                fallback: parseFallbackOptions(get_cOptions<C.runKey, true>()) },
        $then: seqId, $else: "-" + seqId, $retry: -999
      }
      replaceCmdOptions(fakeOptions)
      keyToCommandMap_.set(seqId, makeCommand_("runKey", fakeOptions as CommandsNS.Options)!)
      runKeyInSeq(fakeOptions.$seq!, 1, null, info)
    } else {
      runOneKey(key.val[0], {
        keys: key, repeat, options, cursor: key, timeout: 0, id: seqId, fallback: null
      }, info)
    }
  }
}

//#endregion

//#region run a key sequence (tree)

/**
 * syntax: a?b+c+2d:(e+-3f?-4g:h+i)?:j
 * * `"-"` only contributes to number prefixes
 * * `"%c" | "$c"` means the outer repeat
 */
declare const enum kN { key = 0, list = 1, ifElse = 2, error = 3 }
interface BaseNode { t: kN; val: unknown; par: Node | null }
interface OneKeyInstance { prefix: string, count: number, key: string, options: CommandsNS.RawOptions | null }
interface KeyNode extends BaseNode { t: kN.key; val: string | OneKeyInstance; par: ListNode }
interface ListNode extends BaseNode { t: kN.list; val: (Node | KeyNode)[] }
interface IfElseNode extends BaseNode { t: kN.ifElse; val: { cond: Node, t: Node | null, f: Node | null}; par: Node }
interface ErrorNode extends BaseNode { t: kN.error; val: string; par: null }
type Node = ListNode | IfElseNode
export const parseKeySeq = (keys: string): ListNode | ErrorNode => {
  const re = <RegExpOne>
      /^([$%][a-z]\+?)*([\d-]\d*\+?)?([$%][a-z]\+?)*(<([a-z]-){0,4}\w+(:i)?>|[A-Z_a-z]\w*(\.\w+)?)(#[^()?:+]*)?/
  let cur: ListNode = { t: kN.list, val: [], par: null }, root: ListNode = cur, last: Node | null
  for (let i = keys.length > 1 ? 0 : keys.length; i < keys.length; i++) {
    switch (keys[i]) {
    case "(":
      last = cur; cur = { t: kN.list, val: [], par: cur }; last.val.push(cur)
      break
    case ")": last = cur; do { last = last.par! } while (last.t === kN.ifElse); cur = last; break
    case "?": case ":":
      last = keys[i] === "?" ? null : cur
      while (last && last.t !== kN.ifElse) { last = last.par } 
      if (!last || last.val.f) {
        last = cur.par
        cur.par = { t: kN.ifElse, val: { cond: cur, t: null, f: null },
                    par: last || (root = { t: kN.list, val: [], par: null }) }
        !last ? root.val.push(cur.par)
            : last.t === kN.list ? last.val.splice(last.val.indexOf(cur), 1, cur.par)
            : last.val.t === cur ? last.val.t = cur.par : last.val.f = cur.par
        last = cur.par
      }
      cur = { t: kN.list, val: [], par: last }
      keys[i] === "?" ? last.val.t = cur : last.val.f = cur
      break
    case "+": break
    default:
      while (i < keys.length && !"()?:+".includes(keys[i])) {
        const arr = re.exec(keys.slice(i))
        if (!arr) {
          const err = keys.slice(i)
          return { t: kN.error,
              val: "Invalid key item: " + (err.length > 16 ? err.slice(0, 15) + "\u2026" : err), par: null }
        }
        let oneKey = arr[0]
        const hash = oneKey.indexOf("#")
        if (hash > 0 && (<RegExpOne> /[#&]#/).test(oneKey.slice(hash))) {
          oneKey = keys.slice(i)
        }
        cur.val.push({ t: kN.key, val: oneKey, par: cur })
        i += oneKey.length
      }
      i--
      break
    }
  }
  if (keys.length === 1) { root.val.push({ t: kN.key, val: keys, par: root }) }
  if (!Build.NDEBUG) { (root as Object as {toJSON?: any}).toJSON = exprKeySeq }
  BgUtils_.resetRe_()
  return root
}

const exprKeySeq = function (this: ListNode): object | string | null {
  const ifNotEmpty = (arr: any[]): any[] | null => arr.some(i => i != null) ? arr : null
  const iter = (node: Node | KeyNode | null): object | string | null => {
    return !node ? null
        : node.t == kN.list ? node.val.length === 1 ? iter(node.val[0])
            : node.val.length === 0 ? null : ifNotEmpty(node.val.map(iter))
        : node.t !== kN.ifElse ? As_<string | OneKeyInstance>(node.val)
        : { if: iter(node.val.cond), then: iter(node.val.t), else: iter(node.val.f) }
  }
  return iter(this)
}

const nextKeyInSeq = (lastCursor: ListNode | KeyNode, dir: number): KeyNode | null => {
  let down = true, par: ListNode | IfElseNode, ind: number
  let cursor: Node | KeyNode | null = lastCursor
  if (cursor.t === kN.key) {
    par = cursor.par, ind = par.val.indexOf(cursor!)
    cursor = ind < par.val.length - 1 && dir > 0 ? par.val[ind + 1] : (down = false, par)
  }
  while (cursor && cursor.t !== kN.key) {
    if (down && cursor.t === kN.list && cursor.val.length > 0) {
      cursor = cursor.val[0]
    } else if (down && cursor.t === kN.ifElse) {
      cursor = cursor.val.cond
    } else if (!cursor.par) {
      cursor = null
      break
    } else if (cursor.par.t === kN.list) {
      par = cursor.par, ind = par.val.indexOf(cursor)
      down = ind < par.val.length - 1
      down && dir < 0 && (dir = 1)
      cursor = down ? par.val[ind + 1] : par
    } else {
      par = cursor.par
      down = cursor === par.val.cond
      cursor = down && (dir > 0 ? par.val.t : (dir = 1, par.val.f)) || (down = false, par)
    }
  }
  return cursor
}

export const runKeyInSeq = (seq: BgCmdOptions[C.runKey]["$seq"], dir: number
    , fallback: Req.FallbackOptions["$f"] | null, envInfo: CurrentEnvCache | null): void => {
  const cursor: KeyNode | null = nextKeyInSeq(seq.cursor as ListNode | KeyNode, dir)
  const isLast = !cursor || !(nextKeyInSeq(cursor, 1) || nextKeyInSeq(cursor, -1))
  const finalFallback = seq.fallback
  const seqId = seq.id
  if (isLast) {
    keyToCommandMap_.delete(seqId)
    clearTimeout(seq.timeout || 0)
    if (kStr.RunKeyWithId.replace("$1", "" + loopIdToRunSeq as "1") == seqId) {
      loopIdToRunSeq = Math.max(--loopIdToRunSeq, 0)
    }
    if (cursor) {
      delete get_cOptions<C.runKey, true>().$then, delete get_cOptions<C.runKey, true>().$else
      if (finalFallback) {
        seq.options = seq.options ? Object.assign(finalFallback, seq.options) : finalFallback
      }
    }
  }
  if (!cursor) {
    if (finalFallback) {
      finalFallback.$f ? finalFallback.$f.t = fallback && fallback.t || finalFallback.$f.t
          : finalFallback.$f = fallback
      if (runNextCmdBy(dir > 0 ? 1 : 0, finalFallback, 1)) { return }
    }
    dir < 0 && fallback && fallback.t && showHUD(trans_(`${fallback.t as 99}`))
    return
  }
  const timeout = isLast ? 0 : seq.timeout = setTimeout((): void => {
    const old = keyToCommandMap_.get(seqId)
    const opts2 = old && (old.options_ as KnownOptions<C.runKey>)
    if (opts2 && opts2.$seq && opts2.$seq.timeout === timeout) {
      keyToCommandMap_.delete(seqId)
    }
  }, 30000)
  runOneKey(cursor, seq, envInfo)
}

//#endregion

//#region run one key node with count and placeholder prefixes and a suffix of inline options

const parseKeyNode = (cursor: KeyNode): OneKeyInstance => {
  let str = cursor.val
  if (typeof str !== "string") { return str }
  let arr = (<RegExpOne> /^([$%][a-zA-Z]\+?|-)+/).exec(str)
  const isNegative = !!arr && arr[0].includes("-"), allowPlus = !arr || "+-".includes(arr[0].slice(-1))
  const prefix = !arr ? "" : arr[0].replace(<RegExpOne> /[+-]/g, "").replace(<RegExpOne> /%/g, "$")
  str = arr ? str.slice(arr[0].length) : str
  arr = (<RegExpOne> /^\d+/).exec(str)
  const count = (isNegative ? -1 : 1) * (arr && parseInt(arr[0], 10) || 1)
  str = arr ? str.slice(arr[0].length) : str
  str = allowPlus || arr || !str.startsWith("+") ? str : str.slice(1)
  const hashIndex = str.indexOf("#", 1)
  const key = hashIndex > 0 ? str.slice(0, hashIndex) : str
  let options: CommandsNS.RawOptions | null = null
  if (hashIndex > 0 && hashIndex + 1 < str.length) {
    str = str.slice(hashIndex + 1)
    options = parseEmbeddedOptions(str)
  }
  return cursor.val = { prefix, count, key: key !== "__proto__" ? key : "<v-__proto__>", options }
}

export const parseEmbeddedOptions = (/** has no prefixed "#" */ str: string): CommandsNS.RawOptions | null => {
  const arrHash = (<RegExpOne> /(^|&)#/).exec(str)
  const rawPart = arrHash ? str.slice(arrHash.index + arrHash[0].length) : ""
  const encodeUnicode = (s: string): string => "\\u" + (s.charCodeAt(0) + 0x10000).toString(16).slice(1)
  const encodeValue = (s: string): string =>
      (<RegExpOne> /\s/).test(s) ? JSON.stringify(s).replace(<RegExpG & RegExpSearchable<0>> /\s/g, encodeUnicode) : s
  str = (arrHash ? str.slice(0, arrHash.index) : str).split("&").map((pair): string => {
    const key = pair.split("=", 1)[0], val = pair.slice(key.length)
    return key + (val ? "=" + encodeValue(BgUtils_.DecodeURLPart_(val.slice(1))) : "")
  }).join(" ")
  if (rawPart) {
    const key2 = rawPart.split("=", 1)[0], val2 = rawPart.slice(key2.length)
    str = (str ? str + " " : "") + key2 + (val2 ? "=" + encodeValue(val2.slice(1)) : "")
  }
  return parseOptions_(str, 2)
}

export const runOneKey = (cursor: KeyNode, seq: BgCmdOptions[C.runKey]["$seq"], envInfo: CurrentEnvCache | null) => {
  const info = parseKeyNode(cursor)
  const hasCount = !seq || seq.cursor === seq.keys || info.prefix.includes("$c")
  let options = !seq.options || !info.options ? seq.options || info.options
      : copyCmdOptions(copyCmdOptions(BgUtils_.safeObj_(), info.options), seq.options as CommandsNS.Options)
  seq.cursor = cursor
  /*#__NOINLINE__*/ runKeyWithOptions(info.key, info.count * (hasCount ? seq.repeat : 1), options, envInfo)
}

set_runOneMapping_((key, port, fStatus): void => {
  const arr: null | string[] = (<RegExpOne> /^\d+|^-\d*/).exec(key)
  let count = 1
  if (arr != null) {
    const prefix = arr[0]
    key = key.slice(prefix.length)
    count = prefix !== "-" ? parseInt(prefix, 10) || 1 : -1
  }
  let hash = 1
  while (hash = key.indexOf("#", hash) + 1) {
    const slice = key.slice(0, hash - 1)
    if (keyToCommandMap_.has(slice) || (<RegExpI> /^[a-z]+(\.[a-z]+)?$/i).test(slice)) { break }
  }
  set_cPort(port!)
  set_cKey(kKeyCode.None)
  set_cOptions(null)
  runKeyWithOptions(hash ? key.slice(0, hash - 1) : key, count, hash ? key.slice(hash) : null, null, fStatus)
})

const doesInheritOptions = (baseOptions: CommandsNS.Options): boolean => {
  let cur = get_cOptions<C.blank>() as CommandsNS.Options | undefined
  while (cur && cur !== baseOptions) { cur = cur.$o }
  return cur === baseOptions
}

const runKeyWithOptions = (key: string, count: number, exOptions: CommandsNS.EnvItemOptions | string | null | undefined
    , envInfo: CurrentEnvCache | null, fallbackCounter?: FgReq[kFgReq.nextKey]["f"] | null): void => {
  let finalKey = key, registryEntry = key !== "__proto__" && keyToCommandMap_.get(key)
      || !key.includes("<") && keyToCommandMap_.get(finalKey = `<v-${key}>`) || null
  let entryReadonly = true
  if (registryEntry == null && key in availableCommands_) {
    entryReadonly = false
    registryEntry = makeCommand_(key, null)
  }
  if (registryEntry == null) {
    showHUD(`"${(<RegExpOne> /^\w+$/).test(key) ? finalKey : key}" has not been mapped`)
    return
  } else if (registryEntry.alias_ === kBgCmd.runKey && registryEntry.background_
      && registryEntry.options_ && typeof registryEntry.options_ === "object"
      && doesInheritOptions(registryEntry.options_)) {
    showHUD('"runKey" should not call itself')
    return
  }
  typeof exOptions === "string" && (exOptions = exOptions ? parseEmbeddedOptions(exOptions) : null)
  const cmdOptions = get_cOptions<C.runKey, true>() as KnownOptions<C.runKey> | null
  const fallOpts = cmdOptions && parseFallbackOptions(cmdOptions)
  const fStatus = cmdOptions && cmdOptions.$f
  if (exOptions && typeof exOptions === "object" || fallOpts || fStatus) {
    const originalOptions = normalizedOptions_(registryEntry)
    registryEntry = entryReadonly ? Object.assign<{}, CommandsNS.Item>({}, registryEntry) : registryEntry
    let newOptions: CommandsNS.RawOptions & NonNullable<CommandsNS.EnvItem["options"]> = BgUtils_.safeObj_()
    exOptions && copyCmdOptions(newOptions, BgUtils_.safer_(exOptions))
    fallOpts && copyCmdOptions(newOptions, BgUtils_.safer_(fallOpts))
    originalOptions && copyCmdOptions(newOptions, originalOptions)
    newOptions.$f = fStatus
    if (exOptions && "$count" in exOptions) {
      newOptions.$count = exOptions.$count
    } else if (originalOptions && "$count" in originalOptions) {
      exOptions && "count" in exOptions || (newOptions.$count = originalOptions.$count)
    }
    (registryEntry as Writable<typeof registryEntry>).options_ = newOptions
    if (registryEntry.alias_ === kFgCmd.linkHints && !registryEntry.background_) {
      (registryEntry as Writable<typeof registryEntry>).repeat_ = 0
    }
    normalizeCommand_(registryEntry)
  }
  set_cEnv(envInfo)
  BgUtils_.resetRe_()
  executeCommand(registryEntry, count, cKey, cPort, 0, fallbackCounter)
}

//#endregion
