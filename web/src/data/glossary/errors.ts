import type { GlossaryEntry } from './types';

export const ERRORS_TERMS: GlossaryEntry[] = [
  {
    id: '404',
    term: '404',
    category: 'errors',
    oneLiner_en: 'The HTTP status meaning the requested thing does not exist at that address.',
    oneLiner_zh: 'HTTP 状态码，表示所请求的东西在这个地址上不存在。',
    plainExplain_en:
      'Like visiting an apartment number that is not in the building. Nothing is broken; the address is simply wrong or the item was removed. Check the spelling of the path or id, and whether the run or file still exists.',
    plainExplain_zh:
      '就像去找一栋楼里并不存在的门牌号。并没有什么东西坏掉，只是地址不对，或者那样东西已经被删除。请检查路径或 ID 的拼写，以及对应的运行记录或文件是否还在。',
    proExplain_en:
      'Not Found, a 4xx client error: the server understood the request but has no resource at that URL. The VibeBaton server returns 404 with a JSON `error` for unknown presets, runs, tasks, or CLI drivers, and the client surfaces it as an `ApiError` with status 404.',
    proExplain_zh:
      'Not Found（未找到），属于 4xx 客户端错误：服务器理解了请求，但该 URL 上没有对应资源。VibeBaton 服务器在预设、运行、任务或 CLI 驱动不存在时返回 404 和 JSON `error` 字段，客户端会将其转换为 status 为 404 的 `ApiError`。',
    related: ['status-code', '400', '500', 'url', 'endpoint'],
  },
  {
    id: '500',
    term: '500',
    category: 'errors',
    oneLiner_en: 'The HTTP status meaning something went wrong inside the server itself.',
    oneLiner_zh: 'HTTP 状态码，表示问题出在服务器内部。',
    plainExplain_en:
      'Your order was fine, but something went wrong in the kitchen. Retrying may help if the problem was temporary; otherwise the server log or terminal window usually names the real cause.',
    plainExplain_zh:
      '你的点单没有问题，是后厨出了状况。如果只是暂时性故障，重试也许就好；否则，服务器日志或终端窗口里通常会写明真正的原因。',
    proExplain_en:
      'Internal Server Error, a 5xx server error: the request was valid but the handler failed, for example an unreadable CLI registry, a git command that could not run, or a file write blocked by the operating system. Read the JSON `error` message and the server stderr before retrying.',
    proExplain_zh:
      'Internal Server Error（服务器内部错误），属于 5xx 服务端错误：请求本身合法，但处理过程失败，例如 CLI 注册表无法读取、git 命令无法执行，或文件写入被操作系统拦截。重试前请先查看 JSON 中的 `error` 信息和服务器的标准错误输出。',
    related: ['status-code', '404', '502', '503', 'stack-trace'],
  },
  {
    id: 'timeout',
    term: 'Timeout',
    category: 'errors',
    oneLiner_en: 'An operation was stopped because it did not finish within the allowed time.',
    oneLiner_zh: '某个操作在规定时间内没有完成，因此被停止。',
    plainExplain_en:
      'Like a phone call that rings until the line hangs up on its own. The other side may be busy, slow, or unreachable. Wait a moment and retry; if it keeps happening, check the network or give the task a longer time limit.',
    plainExplain_zh:
      '就像电话一直响到线路自动挂断。对方可能很忙、很慢，或者根本联系不上。稍等片刻再重试；如果反复出现，请检查网络，或者给任务更长的时间上限。',
    proExplain_en:
      'A deadline elapsed before a response, process exit, or lock release arrived, so the caller aborted. In VibeBaton a CLI driver that produces no output past its stall window is treated as stalled and killed; the task can be retried or escalated through the fallback chain.',
    proExplain_zh:
      '在收到响应、进程退出或锁释放之前，截止时间已到，调用方于是中止操作。在 VibeBaton 中，若 CLI 驱动超过停滞窗口仍没有输出，就会被判定为卡住并被终止；该任务可以重试，或沿回退链升级处理。',
    related: ['latency', 'cli-driver', 'fallback-chain', '503', 'infinite-loop'],
  },
  {
    id: 'enoent',
    term: 'ENOENT',
    category: 'errors',
    oneLiner_en: 'A system error meaning a file or folder that was asked for does not exist.',
    oneLiner_zh: '系统错误码，表示所请求的文件或文件夹不存在。',
    plainExplain_en:
      'Like being sent to fetch a box from a shelf that is empty. Check the path for typos, confirm you are in the expected folder, and create or restore the missing file if it should be there.',
    plainExplain_zh:
      '就像被派去货架上取一个箱子，结果那里是空的。请检查路径是否有拼写错误，确认当前所在的文件夹是否正确；如果文件本应存在，就新建或恢复它。',
    proExplain_en:
      '"Error NO ENTry", the POSIX errno raised when a path lookup fails, surfaced by Node.js as `code: \'ENOENT\'` and by Python as `FileNotFoundError`. Common causes are a wrong working directory, a relative path resolved from an unexpected place, or an executable that is not installed.',
    proExplain_zh:
      '“Error NO ENTry”的缩写，是路径查找失败时的 POSIX errno；Node.js 中表现为 `code: \'ENOENT\'`，Python 中表现为 `FileNotFoundError`。常见原因包括工作目录不对、相对路径从意料之外的位置解析，或者可执行程序没有安装。',
    related: ['command-not-found', 'path-too-long', 'config-file', '404'],
  },
  {
    id: 'eaddrinuse',
    term: 'EADDRINUSE',
    category: 'errors',
    oneLiner_en: 'A system error meaning the network port a program wants is already taken.',
    oneLiner_zh: '系统错误码，表示程序想使用的网络端口已经被占用。',
    plainExplain_en:
      'Like arriving at a parking spot that already has a car in it. Often an earlier copy of the same server is still running. Close that window or process, or start the server on a different port.',
    plainExplain_zh:
      '就像到了一个车位，却发现已经停着一辆车。通常是同一个服务器之前启动的副本还在运行。关掉那个窗口或进程，或者换一个端口启动服务器即可。',
    proExplain_en:
      '"Address already in use": `bind()` failed because another socket holds the same address and port. Find the owner with `netstat -ano` on Windows or `lsof -i :PORT` on macOS and Linux, then stop it or pass a different port to the VibeBaton server or Vite.',
    proExplain_zh:
      '“Address already in use”（地址已被占用）：`bind()` 失败，因为另一个套接字已占用同一地址和端口。可在 Windows 上用 `netstat -ano`、在 macOS 和 Linux 上用 `lsof -i :PORT` 找到占用者，然后停止它，或给 VibeBaton 服务器或 Vite 指定别的端口。',
    related: ['port', 'localhost', 'server', 'econnrefused'],
  },
  {
    id: 'merge-conflict',
    term: 'Merge Conflict',
    category: 'errors',
    oneLiner_en: 'Git could not combine two sets of changes automatically because they touch the same lines.',
    oneLiner_zh: 'Git 无法自动合并两组改动，因为它们修改了相同的行。',
    plainExplain_en:
      'Like two editors rewriting the same sentence in different ways; someone has to decide which version stays. Open the marked files, keep the right text, remove the markers, then commit. Nothing is lost while you decide.',
    plainExplain_zh:
      '就像两位编辑用不同方式改写了同一句话，需要有人决定保留哪个版本。打开被标记的文件，保留正确的内容，删掉冲突标记，然后提交即可。在你做出决定之前，任何内容都不会丢失。',
    proExplain_en:
      'During merge, rebase, or cherry-pick, overlapping hunks are written with `<<<<<<<`, `=======`, and `>>>>>>>` markers and the operation pauses. Resolve each file, `git add` it, and continue, or abort with `git merge --abort`. VibeBaton pauses a task in waiting-human when a worktree merge conflicts.',
    proExplain_zh:
      '在 merge、rebase 或 cherry-pick 过程中，重叠的代码块会被写入 `<<<<<<<`、`=======` 和 `>>>>>>>` 标记，操作随之暂停。逐个解决文件后执行 `git add` 并继续，或用 `git merge --abort` 放弃。当 worktree 合并出现冲突时，VibeBaton 会把任务置为等待人工状态。',
    related: ['conflict', 'merge', 'rebase', 'waiting-human', 'diff'],
  },
  {
    id: 'type-error',
    term: 'Type Error',
    category: 'errors',
    oneLiner_en: 'A value was used as a kind of thing it is not, such as calling a number like a function.',
    oneLiner_zh: '某个值被当成了它并不是的类型来使用，比如把数字当函数调用。',
    plainExplain_en:
      'Like trying to pour water from a book. The message names the value and the place it was misused; look there and check what kind of value actually arrived.',
    plainExplain_zh:
      '就像试图从一本书里倒出水来。错误信息会指出是哪个值、在哪里被误用；去那里看看实际传进来的值到底是什么类型。',
    proExplain_en:
      'Raised when an operation receives an operand of the wrong type: JavaScript `TypeError` at runtime, Python `TypeError`, or a TypeScript compile-time diagnostic from `tsc`. Compile-time type errors are caught by the type-check step of the mechanical gate before code runs.',
    proExplain_zh:
      '当运算收到类型不对的操作数时抛出：JavaScript 运行时的 `TypeError`、Python 的 `TypeError`，或 `tsc` 给出的 TypeScript 编译期诊断。编译期类型错误会在代码运行前被机械闸门中的类型检查步骤拦下。',
    related: ['type-check', 'typescript', 'null-reference', 'mechanical-gate', 'stack-trace'],
  },
  {
    id: 'import-error',
    term: 'Import Error',
    category: 'errors',
    oneLiner_en: 'A program could not load a module or package it depends on.',
    oneLiner_zh: '程序无法加载它所依赖的模块或包。',
    plainExplain_en:
      'Like a recipe that calls for an ingredient missing from the pantry. Install the dependencies again, check the module name for typos, and make sure you are using the project environment.',
    plainExplain_zh:
      '就像菜谱需要的某样食材在储藏室里找不到。重新安装依赖，检查模块名是否拼错，并确认使用的是项目自己的环境。',
    proExplain_en:
      'Module resolution failed: Python raises `ImportError` or `ModuleNotFoundError`, Node.js reports `ERR_MODULE_NOT_FOUND`, and bundlers report an unresolved import. Typical causes are an uninstalled package, a wrong virtual environment, a renamed export, or a path alias the tool does not know.',
    proExplain_zh:
      '模块解析失败：Python 抛出 `ImportError` 或 `ModuleNotFoundError`，Node.js 报 `ERR_MODULE_NOT_FOUND`，打包工具则报告无法解析的导入。常见原因有包未安装、虚拟环境不对、导出被改名，或工具不认识某个路径别名。',
    related: ['module', 'dependency', 'package-manager', 'dependency-conflict', 'enoent'],
  },
  {
    id: 'rate-limit',
    term: 'Rate Limit',
    category: 'errors',
    oneLiner_en: 'A service is refusing extra requests because too many arrived in a short time.',
    oneLiner_zh: '服务因为短时间内收到太多请求而拒绝额外的请求。',
    plainExplain_en:
      'Like a ticket counter that serves only so many people per minute. Waiting a little and trying again usually works; spacing out requests or lowering parallelism prevents it.',
    plainExplain_zh:
      '就像售票窗口每分钟只接待固定人数。稍等一会儿再试通常就能成功；拉开请求间隔或降低并发可以避免它。',
    proExplain_en:
      'A throttle that caps requests or tokens per time window, usually signaled with HTTP 429 and a `Retry-After` header. VibeBaton treats provider rate limits as quota signals: the role enters quota cooldown and work can move along the fallback chain.',
    proExplain_zh:
      '一种按时间窗口限制请求数或 token 数的节流机制，通常以 HTTP 429 和 `Retry-After` 头表示。VibeBaton 把服务商的速率限制视为配额信号：对应角色进入配额冷却，工作可沿回退链转移。',
    related: ['429', 'quota-exceeded', 'quota-cooldown', 'fallback-chain', 'api-key'],
  },
  {
    id: 'auth-error',
    term: 'Auth Error',
    category: 'errors',
    oneLiner_en: 'A service could not confirm who is calling or whether they are allowed in.',
    oneLiner_zh: '服务无法确认调用者是谁，或无法确认其是否有权限进入。',
    plainExplain_en:
      'Like a badge reader that does not recognize the card. The key may be expired, mistyped, or meant for another account. Sign in again or paste a fresh API key, then retry.',
    plainExplain_zh:
      '就像门禁读卡器不认识这张卡。密钥可能已过期、填错，或者属于另一个账号。重新登录或填入新的 API 密钥后再试。',
    proExplain_en:
      'An authentication or authorization failure, usually HTTP 401 (credentials missing or invalid) or 403 (identity known but not permitted). For CLI drivers it often means the CLI session expired; rerun the provider login command or update the environment variable that holds the key.',
    proExplain_zh:
      '身份验证或授权失败，通常是 HTTP 401（凭据缺失或无效）或 403（身份已知但无权限）。对 CLI 驱动而言，常常意味着 CLI 会话已过期；重新运行服务商的登录命令，或更新保存密钥的环境变量即可。',
    related: ['401', '403', 'api-key', 'cli-driver', 'environment-variable'],
  },
  {
    id: '400',
    term: '400',
    category: 'errors',
    oneLiner_en: 'The HTTP status meaning the server could not understand the request as sent.',
    oneLiner_zh: 'HTTP 状态码，表示服务器无法理解所发送的请求。',
    plainExplain_en:
      'Like handing in a form with a field the clerk cannot read. The response usually says which field is wrong; adjust that value and send it again.',
    plainExplain_zh:
      '就像交了一张办事员看不懂某一栏的表格。响应里通常会写明哪一栏有问题；改好那个值再重新发送即可。',
    proExplain_en:
      'Bad Request, a 4xx client error for malformed syntax or invalid parameters, such as broken JSON or a missing required field. The VibeBaton server returns 400 with a JSON `error` describing the failed validation.',
    proExplain_zh:
      'Bad Request（错误请求），属于 4xx 客户端错误，用于语法错误或参数无效，例如 JSON 格式损坏或缺少必填字段。VibeBaton 服务器返回 400 时会附带说明校验失败原因的 JSON `error`。',
    related: ['status-code', 'request', 'json', '404', 'schema'],
  },
  {
    id: '401',
    term: '401',
    category: 'errors',
    oneLiner_en: 'The HTTP status meaning the request needs valid credentials that were not provided.',
    oneLiner_zh: 'HTTP 状态码，表示请求需要有效凭据，但没有提供。',
    plainExplain_en:
      'Like a door that asks for a key before letting anyone in. Sign in again or check that the API key is set and current, then retry.',
    plainExplain_zh:
      '就像一扇需要先出示钥匙才让人进的门。重新登录，或检查 API 密钥是否已设置且仍然有效，然后重试。',
    proExplain_en:
      'Unauthorized, which in practice means unauthenticated: the request lacked credentials or they were rejected. The response may include a `WWW-Authenticate` header describing the expected scheme.',
    proExplain_zh:
      'Unauthorized（未授权），实际含义是未通过身份验证：请求没有携带凭据，或凭据被拒绝。响应中可能包含 `WWW-Authenticate` 头，说明期望的认证方式。',
    related: ['auth-error', '403', 'api-key', 'header', 'status-code'],
  },
  {
    id: '403',
    term: '403',
    category: 'errors',
    oneLiner_en: 'The HTTP status meaning the server knows who you are but this action is not permitted.',
    oneLiner_zh: 'HTTP 状态码，表示服务器知道你是谁，但不允许执行这个操作。',
    plainExplain_en:
      'Like a valid staff badge that still does not open the server room. Ask for the needed permission, switch to an account that has it, or choose an action within your current access.',
    plainExplain_zh:
      '就像一张有效的员工卡仍然打不开机房的门。可以申请所需权限、换用有权限的账号，或者选择当前权限范围内的操作。',
    proExplain_en:
      'Forbidden: the identity is authenticated but not authorized for this resource. Re-authenticating with the same identity will not help; the permission, plan, or scope attached to the credentials must change.',
    proExplain_zh:
      'Forbidden（禁止访问）：身份已通过验证，但无权访问该资源。用同一身份重新登录无济于事；必须修改凭据所附带的权限、套餐或作用范围。',
    related: ['401', 'auth-error', 'permission-denied', 'status-code'],
  },
  {
    id: '409',
    term: '409',
    category: 'errors',
    oneLiner_en: 'The HTTP status meaning the request clashes with the current state of the resource.',
    oneLiner_zh: 'HTTP 状态码，表示请求与资源当前的状态相冲突。',
    plainExplain_en:
      'Like trying to book a seat that someone reserved a moment ago. Refresh to see the latest state, then decide whether to retry, wait, or pick another option.',
    plainExplain_zh:
      '就像想订一个刚刚被别人订走的座位。刷新查看最新状态，再决定是重试、等待，还是换一个选择。',
    proExplain_en:
      'Conflict: the request is well formed but cannot apply to the resource as it is now, for example starting a run that is already running or saving over a newer version. The VibeBaton server uses 409 for such state clashes.',
    proExplain_zh:
      'Conflict（冲突）：请求格式正确，但无法作用于资源的当前状态，例如启动一个已在运行的任务，或覆盖一个更新的版本。VibeBaton 服务器在遇到这类状态冲突时返回 409。',
    related: ['status-code', 'race-condition', 'file-locked', '400'],
  },
  {
    id: '429',
    term: '429',
    category: 'errors',
    oneLiner_en: 'The HTTP status meaning too many requests were sent in a given amount of time.',
    oneLiner_zh: 'HTTP 状态码，表示在一定时间内发送的请求太多。',
    plainExplain_en:
      'Like a shop that asks new customers to wait outside until there is room. Pause and retry later; the response often says how long to wait.',
    plainExplain_zh:
      '就像店里客满时请新来的顾客在门外稍等。暂停一下再重试；响应里往往会写明需要等多久。',
    proExplain_en:
      'Too Many Requests, the standard rate-limit response, often with a `Retry-After` header in seconds or as a date. Clients should back off exponentially instead of retrying immediately.',
    proExplain_zh:
      'Too Many Requests（请求过多），标准的速率限制响应，常附带以秒数或日期表示的 `Retry-After` 头。客户端应采用指数退避，而不是立即重试。',
    related: ['rate-limit', 'quota-exceeded', 'quota-cooldown', 'status-code', 'header'],
  },
  {
    id: '502',
    term: '502',
    category: 'errors',
    oneLiner_en: 'The HTTP status meaning a middleman server got a bad answer from the server behind it.',
    oneLiner_zh: 'HTTP 状态码，表示中间服务器从它背后的服务器那里收到了无效回应。',
    plainExplain_en:
      'Like a receptionist who called the back office and got only static. The back office may be restarting or down. Wait a moment and retry, or check that the backend process is running.',
    plainExplain_zh:
      '就像前台打电话给后台办公室，却只听到杂音。后台可能正在重启或已经停机。稍等再试，或检查后端进程是否在运行。',
    proExplain_en:
      'Bad Gateway: a proxy or gateway received an invalid or empty response from the upstream server. In local development this often appears when the Vite dev proxy forwards to a backend that crashed or has not started yet.',
    proExplain_zh:
      'Bad Gateway（网关错误）：代理或网关从上游服务器收到了无效或空的响应。在本地开发中，当 Vite 开发代理转发到一个已崩溃或尚未启动的后端时，经常会出现这个错误。',
    related: ['proxy', '500', '503', 'backend', 'econnrefused'],
  },
  {
    id: '503',
    term: '503',
    category: 'errors',
    oneLiner_en: 'The HTTP status meaning the server is temporarily unable to handle the request.',
    oneLiner_zh: 'HTTP 状态码，表示服务器暂时无法处理请求。',
    plainExplain_en:
      'Like a shop with a sign saying "back in five minutes". The service is overloaded or under maintenance; retry after a short wait.',
    plainExplain_zh:
      '就像店门口挂着“五分钟后回来”的牌子。服务正处于过载或维护中；稍等一会儿再试即可。',
    proExplain_en:
      'Service Unavailable: a temporary condition such as overload, maintenance, or a dependency outage, sometimes with a `Retry-After` header. AI providers return it during capacity crunches, so retry with backoff or switch to a fallback provider.',
    proExplain_zh:
      'Service Unavailable（服务不可用）：暂时性状况，例如过载、维护或依赖服务中断，有时附带 `Retry-After` 头。AI 服务商在算力紧张时会返回它，可以退避重试，或切换到备用服务商。',
    related: ['500', '502', '429', 'fallback-chain', 'provider'],
  },
  {
    id: 'syntax-error',
    term: 'Syntax Error',
    category: 'errors',
    oneLiner_en: 'The code or data is not written in a form the language can parse.',
    oneLiner_zh: '代码或数据的写法不符合语言的语法，无法被解析。',
    plainExplain_en:
      'Like a sentence with a missing closing quote, so the reader cannot tell where it ends. The message points to a line and column; check there and just before it for a missing bracket, comma, or quote.',
    plainExplain_zh:
      '就像一句话少了后引号，读者分不清它在哪里结束。错误信息会指出行号和列号；检查那里以及它前面一点，看是否缺了括号、逗号或引号。',
    proExplain_en:
      'A parse-time failure raised before any code runs: Python `SyntaxError`, JavaScript `SyntaxError`, or `JSON.parse` rejecting malformed JSON. The reported position is where the parser gave up, which is often just after the real mistake.',
    proExplain_zh:
      '在任何代码执行之前的解析阶段失败：Python 的 `SyntaxError`、JavaScript 的 `SyntaxError`，或 `JSON.parse` 拒绝格式错误的 JSON。报告的位置是解析器放弃的地方，真正的错误往往就在它前面一点。',
    related: ['lint', 'json', 'type-error', 'stack-trace'],
  },
  {
    id: 'null-reference',
    term: 'Null Reference',
    category: 'errors',
    oneLiner_en: 'The code tried to use something that turned out to be empty: null, None, or undefined.',
    oneLiner_zh: '代码试图使用一个实际上为空的东西：null、None 或 undefined。',
    plainExplain_en:
      'Like reaching for a cup on the table and finding none there. Look at where the value should have been set, and add a check for the case where it is missing.',
    plainExplain_zh:
      '就像伸手去拿桌上的杯子，结果那里什么都没有。查看这个值本该在哪里被赋值，并为它缺失的情况加上检查。',
    proExplain_en:
      'Dereferencing an absent value, e.g. "Cannot read properties of undefined" in JavaScript or `AttributeError: \'NoneType\' object has no attribute` in Python. TypeScript strict null checks and optional chaining (`?.`) catch many of these before runtime.',
    proExplain_zh:
      '对一个不存在的值进行解引用，例如 JavaScript 中的 “Cannot read properties of undefined”，或 Python 中的 `AttributeError: \'NoneType\' object has no attribute`。TypeScript 的严格空值检查和可选链（`?.`）能在运行前拦下其中大部分。',
    related: ['type-error', 'type-check', 'stack-trace', 'typescript'],
  },
  {
    id: 'stack-trace',
    term: 'Stack Trace',
    category: 'errors',
    oneLiner_en: 'The list of function calls that were active when an error happened, from outermost to innermost.',
    oneLiner_zh: '出错时处于活动状态的函数调用列表，按层层调用的顺序排列。',
    plainExplain_en:
      'Like a trail of breadcrumbs showing exactly how the program got to the problem. Start reading from the lines that mention your own files; they usually point at the code worth looking at first.',
    plainExplain_zh:
      '就像一串面包屑，准确记录了程序是怎么一步步走到问题处的。先看提到你自己项目文件的那几行，它们通常指向最值得先检查的代码。',
    proExplain_en:
      'A snapshot of the call stack at the throw site, one frame per line with file, line, and function. Python prints the innermost frame last ("most recent call last"); JavaScript prints it first. Include it verbatim when asking for help or filing a bug.',
    proExplain_zh:
      '抛出异常时调用栈的快照，每行一帧，包含文件、行号和函数名。Python 把最内层的帧打印在最后（“most recent call last”），JavaScript 则打印在最前。求助或提交问题时，请原样附上它。',
    related: ['logging', 'exit-code', '500', 'type-error'],
  },
  {
    id: 'exit-code',
    term: 'Exit Code',
    category: 'errors',
    oneLiner_en: 'The number a program returns when it finishes; zero means success, anything else signals a problem.',
    oneLiner_zh: '程序结束时返回的数字；0 表示成功，其他值表示出了问题。',
    plainExplain_en:
      'Like a thumbs up or a coded note left by someone finishing a shift. A non-zero code means look at the output just above it to find what went wrong.',
    plainExplain_zh:
      '就像下班的人留下的一个竖大拇指，或一张写着代码的便条。如果不是 0，就看看它上方的输出，找到出错原因。',
    proExplain_en:
      'The process status visible as `$?` in POSIX shells, `%ERRORLEVEL%` in cmd, or `$LASTEXITCODE` in PowerShell. Conventions include 1 for general failure, 2 for misuse, 127 for command not found, and 128+N for termination by signal N. VibeBaton gates pass or fail on the exit code of the verification command.',
    proExplain_zh:
      '进程退出状态，在 POSIX shell 中是 `$?`，在 cmd 中是 `%ERRORLEVEL%`，在 PowerShell 中是 `$LASTEXITCODE`。惯例上 1 表示一般失败，2 表示用法错误，127 表示找不到命令，128+N 表示被信号 N 终止。VibeBaton 的闸门依据验证命令的退出码判定通过或失败。',
    related: ['mechanical-gate', 'cli', 'command-not-found', 'test-failure'],
  },
  {
    id: 'command-not-found',
    term: 'Command Not Found',
    category: 'errors',
    oneLiner_en: 'The shell could not find a program with the name that was typed.',
    oneLiner_zh: 'Shell 找不到与输入名称对应的程序。',
    plainExplain_en:
      'Like asking for a colleague who does not work in this building. The tool may not be installed yet, or it is installed somewhere the shell does not look. Install it, or reopen the terminal after installing so it picks up the new location.',
    plainExplain_zh:
      '就像打听一位并不在这栋楼里办公的同事。这个工具可能还没安装，或者装在了 shell 不会去找的位置。安装它，或在安装后重新打开终端，让终端识别新的位置。',
    proExplain_en:
      'The executable is not on `PATH`: bash prints "command not found" with exit 127, and cmd prints "is not recognized as an internal or external command". VibeBaton\'s CLI registry checks each driver binary and marks missing ones unavailable instead of failing a run mid-way.',
    proExplain_zh:
      '可执行文件不在 `PATH` 中：bash 输出 “command not found” 并以 127 退出，cmd 输出 “不是内部或外部命令”。VibeBaton 的 CLI 注册表会逐一检查各驱动的可执行文件，把缺失的标为不可用，而不是让运行中途失败。',
    related: ['cli', 'cli-driver', 'environment-variable', 'exit-code', 'enoent'],
  },
  {
    id: 'permission-denied',
    term: 'Permission Denied',
    category: 'errors',
    oneLiner_en: 'The operating system blocked access to a file, folder, or action.',
    oneLiner_zh: '操作系统阻止了对某个文件、文件夹或操作的访问。',
    plainExplain_en:
      'Like a locked cabinet that your key does not fit. Check who owns the file, close programs that might be guarding it, or run the step from a folder you have rights to.',
    plainExplain_zh:
      '就像一个你的钥匙打不开的上锁柜子。检查文件归谁所有，关闭可能正在占用它的程序，或者在你有权限的文件夹里执行这一步。',
    proExplain_en:
      'A generic access-control failure, reported as `EACCES` or `EPERM` by Node.js, `PermissionError` by Python, and "Access is denied" on Windows. Prefer fixing ownership or the target location over running everything as administrator.',
    proExplain_zh:
      '通用的访问控制失败，Node.js 报 `EACCES` 或 `EPERM`，Python 报 `PermissionError`，Windows 显示“拒绝访问”。优先修正文件所有权或换一个目标位置，而不是一律以管理员身份运行。',
    related: ['eacces', '403', 'file-locked', 'sandbox'],
  },
  {
    id: 'eacces',
    term: 'EACCES',
    category: 'errors',
    oneLiner_en: 'A system error meaning the current user lacks permission for a file or port.',
    oneLiner_zh: '系统错误码，表示当前用户对某个文件或端口没有权限。',
    plainExplain_en:
      'Like a door that opens only for certain staff. Use a folder you own, pick a port above 1024, or adjust the file permissions, then retry.',
    plainExplain_zh:
      '就像一扇只对特定员工开放的门。换用你拥有的文件夹、选一个 1024 以上的端口，或调整文件权限，然后重试。',
    proExplain_en:
      'The POSIX errno for "permission denied", raised when file mode bits or ACLs forbid the access, or when binding to a privileged port below 1024 without elevated rights. A frequent case is a global npm install into a system-owned directory.',
    proExplain_zh:
      '表示“权限不足”的 POSIX errno：文件权限位或 ACL 禁止访问时，或在没有提升权限的情况下绑定 1024 以下的特权端口时出现。一个常见场景是把 npm 包全局安装到系统所有的目录中。',
    related: ['permission-denied', 'port', 'package-manager', 'enoent'],
  },
  {
    id: 'econnrefused',
    term: 'ECONNREFUSED',
    category: 'errors',
    oneLiner_en: 'A system error meaning nothing is listening at the address and port being contacted.',
    oneLiner_zh: '系统错误码，表示所连接的地址和端口上没有程序在监听。',
    plainExplain_en:
      'Like calling a number where nobody has picked up the line in the first place. Start the server you are trying to reach, or check that the address and port match where it is running.',
    plainExplain_zh:
      '就像拨打一个根本没人接线的号码。启动你要连接的服务器，或检查地址和端口是否与它实际运行的位置一致。',
    proExplain_en:
      '"Connection refused": the target host actively rejected the TCP handshake, usually because no process is bound to that port. Typical causes are a backend that has not started, a crashed server, or a mismatch such as `localhost` resolving to IPv6 while the server listens on IPv4.',
    proExplain_zh:
      '“Connection refused”（连接被拒绝）：目标主机主动拒绝了 TCP 握手，通常是因为该端口上没有进程在监听。常见原因包括后端尚未启动、服务器已崩溃，或 `localhost` 解析为 IPv6 而服务器只监听 IPv4 之类的不匹配。',
    related: ['port', 'localhost', 'server', 'eaddrinuse', '502'],
  },
  {
    id: 'out-of-memory',
    term: 'Out of Memory',
    category: 'errors',
    oneLiner_en: 'A program asked for more memory than the system or its limit allows.',
    oneLiner_zh: '程序申请的内存超过了系统或其上限所允许的范围。',
    plainExplain_en:
      'Like trying to fit one more box into a van that is already full. Close other heavy programs, process the data in smaller pieces, or raise the memory limit for that tool.',
    plainExplain_zh:
      '就像想往已经塞满的货车里再放一个箱子。关闭其他占用较多资源的程序，把数据分成小块处理，或提高该工具的内存上限。',
    proExplain_en:
      'Allocation failed: Node.js reports "JavaScript heap out of memory" (raise it with `--max-old-space-size`), Python raises `MemoryError`, and the OS may kill the process outright. Unbounded caches, loading whole files at once, and infinite loops that grow a collection are common causes.',
    proExplain_zh:
      '内存分配失败：Node.js 报 “JavaScript heap out of memory”（可用 `--max-old-space-size` 调高上限），Python 抛出 `MemoryError`，操作系统也可能直接终止进程。无上限的缓存、一次性读入整个文件、以及不断扩张集合的死循环都是常见原因。',
    related: ['infinite-loop', 'exit-code', 'build', 'quota-exceeded'],
  },
  {
    id: 'dependency-conflict',
    term: 'Dependency Conflict',
    category: 'errors',
    oneLiner_en: 'Two packages need incompatible versions of the same third package.',
    oneLiner_zh: '两个包需要同一个第三方包的不兼容版本。',
    plainExplain_en:
      'Like two appliances that each need a different plug for the same socket. Read which packages disagree, then upgrade or pin one so they can agree on a shared version.',
    plainExplain_zh:
      '就像两台电器要往同一个插座插不同规格的插头。看清是哪些包意见不一致，然后升级或固定其中一个，让它们能共用同一个版本。',
    proExplain_en:
      'The resolver cannot find a version set that satisfies every semver range, reported by npm as `ERESOLVE` and by pip as "ResolutionImpossible". Fix by aligning versions, using overrides or constraints, and committing the updated lockfile rather than forcing with `--legacy-peer-deps`.',
    proExplain_zh:
      '依赖解析器找不到能同时满足所有 semver 范围的版本组合，npm 报 `ERESOLVE`，pip 报 “ResolutionImpossible”。解决办法是对齐版本、使用 overrides 或约束文件，并提交更新后的 lockfile，而不是用 `--legacy-peer-deps` 强行绕过。',
    related: ['dependency', 'semver', 'lockfile', 'package-manager', 'version-mismatch'],
  },
  {
    id: 'version-mismatch',
    term: 'Version Mismatch',
    category: 'errors',
    oneLiner_en: 'A tool or library is a different version from the one the project expects.',
    oneLiner_zh: '某个工具或库的版本与项目所期望的不同。',
    plainExplain_en:
      'Like following a manual written for last year\'s model. Check which version the project asks for, then install that version or update the project to match the one you have.',
    plainExplain_zh:
      '就像拿着去年型号的说明书操作今年的机器。查看项目要求的版本，然后安装那个版本，或者更新项目以适配你现有的版本。',
    proExplain_en:
      'The installed runtime, CLI, or package falls outside the range declared in files such as `package.json` `engines`, `pyproject.toml`, or a lockfile. Symptoms range from explicit "requires Node >= 20" messages to missing APIs; compare `--version` output against the declared range.',
    proExplain_zh:
      '已安装的运行时、CLI 或包超出了 `package.json` 的 `engines`、`pyproject.toml` 或 lockfile 等文件所声明的范围。症状从明确的 “requires Node >= 20” 提示到 API 缺失不等；把 `--version` 的输出与声明的范围对照即可。',
    related: ['semver', 'dependency-conflict', 'lockfile', 'cli-driver'],
  },
  {
    id: 'encoding-error',
    term: 'Encoding Error',
    category: 'errors',
    oneLiner_en: 'Text bytes were read or written with the wrong character encoding.',
    oneLiner_zh: '文本的字节用错误的字符编码进行了读写。',
    plainExplain_en:
      'Like reading a letter through a decoder ring meant for a different code, so the words come out garbled. Save or read the file as UTF-8, and make sure the terminal uses UTF-8 too.',
    plainExplain_zh:
      '就像用另一套密码的解码盘去读一封信，读出来全是乱码。把文件以 UTF-8 保存或读取，并确认终端也使用 UTF-8。',
    proExplain_en:
      'Bytes do not match the codec in use: Python raises `UnicodeDecodeError` or `UnicodeEncodeError`, and other tools show mojibake. On Windows a legacy code page such as GBK or cp1252 is a frequent cause; pass `encoding="utf-8"` explicitly or set `PYTHONUTF8=1`.',
    proExplain_zh:
      '字节与所用编解码器不匹配：Python 抛出 `UnicodeDecodeError` 或 `UnicodeEncodeError`，其他工具则显示乱码。在 Windows 上，GBK 或 cp1252 等旧代码页是常见原因；可显式传入 `encoding="utf-8"`，或设置 `PYTHONUTF8=1`。',
    related: ['environment-variable', 'config-file', 'syntax-error', 'json'],
  },
  {
    id: 'path-too-long',
    term: 'Path Too Long',
    category: 'errors',
    oneLiner_en: 'A file path exceeds the maximum length the system or tool accepts.',
    oneLiner_zh: '文件路径超过了系统或工具所能接受的最大长度。',
    plainExplain_en:
      'Like an address too long to fit on the envelope. Move the project to a shorter folder such as near the drive root, or enable long path support, then retry.',
    plainExplain_zh:
      '就像地址太长，信封上写不下。把项目移到更短的目录（例如靠近磁盘根目录的位置），或开启长路径支持，然后重试。',
    proExplain_en:
      'Classic Windows APIs cap paths at 260 characters (`MAX_PATH`). Deep `node_modules` trees and nested worktrees hit it easily; enable `LongPathsEnabled` in the registry and `git config core.longpaths true`, or shorten the base directory.',
    proExplain_zh:
      '传统 Windows API 把路径长度限制在 260 个字符（`MAX_PATH`）。层级很深的 `node_modules` 和嵌套的 worktree 很容易触发；可在注册表中开启 `LongPathsEnabled` 并执行 `git config core.longpaths true`，或缩短项目所在的根目录。',
    related: ['worktree', 'enoent', 'config-file', 'package-manager'],
  },
  {
    id: 'file-locked',
    term: 'File Locked',
    category: 'errors',
    oneLiner_en: 'A file cannot be changed because another program is currently holding it open.',
    oneLiner_zh: '文件无法修改，因为另一个程序正占用着它。',
    plainExplain_en:
      'Like a meeting room with someone still inside. Close the editor, terminal, or antivirus scan that may be using the file, wait a moment, and try again.',
    plainExplain_zh:
      '就像会议室里还有人没出来。关闭可能正在使用该文件的编辑器、终端或杀毒扫描，稍等片刻再试。',
    proExplain_en:
      'Windows enforces mandatory sharing locks, so deleting or renaming an open file fails with `EBUSY`, `EPERM`, or "The process cannot access the file because it is being used by another process". Git also uses `index.lock`; if no git process is running, a leftover lock file can be removed.',
    proExplain_zh:
      'Windows 会强制执行共享锁，因此删除或重命名一个已打开的文件会因 `EBUSY`、`EPERM` 或“另一个程序正在使用此文件，进程无法访问”而失败。Git 也会使用 `index.lock`；如果确认没有 git 进程在运行，可以删除残留的锁文件。',
    related: ['permission-denied', 'deadlock', 'atomic-write', 'race-condition'],
  },
  {
    id: 'dirty-working-tree',
    term: 'Dirty Working Tree',
    category: 'errors',
    oneLiner_en: 'Git refuses an action because there are uncommitted changes that it could overwrite.',
    oneLiner_zh: 'Git 拒绝执行某个操作，因为存在可能被覆盖的未提交改动。',
    plainExplain_en:
      'Like a moving crew that will not start until you pack the items left on the desk. Commit or stash your changes, then run the action again; your work stays safe either way.',
    plainExplain_zh:
      '就像搬家工人要等你把桌上的东西收好才开工。先提交或暂存你的改动，再重新执行操作；无论哪种方式，你的工作都会被妥善保留。',
    proExplain_en:
      'The working tree or index differs from HEAD, so commands such as checkout, rebase, or merge stop with "Your local changes would be overwritten". Inspect with `git status`, then commit, `git stash push`, or discard deliberately. VibeBaton requires a clean tree before starting a run.',
    proExplain_zh:
      '工作区或暂存区与 HEAD 不一致，因此 checkout、rebase、merge 等命令会以 “Your local changes would be overwritten” 停止。先用 `git status` 查看，然后提交、执行 `git stash push`，或有意识地丢弃改动。VibeBaton 要求在开始运行前工作区是干净的。',
    related: ['working-tree', 'stash', 'commit', 'staging-area', 'baton-backup'],
  },
  {
    id: 'detached-head-error',
    term: 'Detached HEAD Warning',
    category: 'errors',
    oneLiner_en: 'Git notes that you are on a specific commit rather than a branch, so new commits could be easy to lose.',
    oneLiner_zh: 'Git 提示你当前位于某个具体提交上，而不是某个分支上，新的提交可能容易丢失。',
    plainExplain_en:
      'Like writing in a notebook that is not on any shelf yet. Nothing is wrong right now; if you plan to keep new work, create a branch here first so it has a home.',
    plainExplain_zh:
      '就像在一本还没放上任何书架的笔记本里写字。眼下并没有出错；如果打算保留新的工作，先在这里创建一个分支，让它有个归处。',
    proExplain_en:
      'HEAD points directly at a commit after checking out a tag, a hash, or during a rebase. Commits made here are reachable only through the reflog once you switch away; run `git switch -c <name>` to keep them, or `git switch <branch>` to return.',
    proExplain_zh:
      'checkout 某个标签或哈希后，或在 rebase 过程中，HEAD 会直接指向一个提交。在此状态下的提交一旦切走，就只能通过 reflog 找回；运行 `git switch -c <name>` 保留它们，或用 `git switch <branch>` 回到分支。',
    related: ['detached-head', 'head', 'branch', 'switch', 'commit-hash'],
  },
  {
    id: 'test-failure',
    term: 'Test Failure',
    category: 'errors',
    oneLiner_en: 'An automated test found that the code did not behave as expected.',
    oneLiner_zh: '自动化测试发现代码的行为不符合预期。',
    plainExplain_en:
      'Like a smoke alarm doing its job: it caught a problem before users did. Read the expected and actual values in the report, then fix the code or update the test if the expectation changed on purpose.',
    plainExplain_zh:
      '就像烟雾报警器在尽职工作：它赶在用户之前发现了问题。阅读报告里的期望值和实际值，然后修正代码；如果预期是有意改变的，就更新测试。',
    proExplain_en:
      'An assertion failed or the test threw, producing a non-zero exit code from the runner such as vitest or pytest. In VibeBaton a failing verification command fails the mechanical gate, and the task is retried with the failure output as context.',
    proExplain_zh:
      '断言失败或测试抛出异常，使 vitest、pytest 等测试运行器以非零退出码结束。在 VibeBaton 中，验证命令失败即机械闸门失败，任务会带着失败输出作为上下文重试。',
    related: ['unit-test', 'assertion', 'mechanical-gate', 'flaky-test', 'regression'],
  },
  {
    id: 'flaky-test',
    term: 'Flaky Test',
    category: 'errors',
    oneLiner_en: 'A test that sometimes passes and sometimes fails without any code change.',
    oneLiner_zh: '在代码没有任何改动的情况下，时而通过、时而失败的测试。',
    plainExplain_en:
      'Like a doorbell that rings only some of the time. Rerun it to confirm, then look for timing, randomness, or shared state; fixing the cause is better than retrying forever.',
    plainExplain_zh:
      '就像一个时灵时不灵的门铃。先重跑确认，再排查时间、随机性或共享状态方面的问题；修正根因比无休止地重试更好。',
    proExplain_en:
      'Non-deterministic results usually come from real timers, unordered iteration, network calls, test order dependence, or race conditions. Stabilize with fake timers, fixed seeds, mocks, and isolated fixtures; quarantine only as a short-term measure.',
    proExplain_zh:
      '结果不确定通常源于真实计时器、无序遍历、网络调用、测试顺序依赖或竞态条件。可借助假计时器、固定随机种子、mock 和相互隔离的 fixture 让它稳定；隔离搁置只能作为短期措施。',
    related: ['test-failure', 'race-condition', 'mock', 'fixture', 'ci'],
  },
  {
    id: 'infinite-loop',
    term: 'Infinite Loop',
    category: 'errors',
    oneLiner_en: 'A loop whose exit condition is never met, so the program keeps running without finishing.',
    oneLiner_zh: '退出条件永远不会满足的循环，导致程序一直运行而无法结束。',
    plainExplain_en:
      'Like a revolving door that never lets anyone step out. Stop the program with Ctrl+C, then check that whatever controls the loop actually changes on every pass.',
    plainExplain_zh:
      '就像一扇永远不让人走出去的旋转门。用 Ctrl+C 停止程序，然后检查控制循环的条件是否在每一轮都真的发生了变化。',
    proExplain_en:
      'Control flow that never reaches its termination condition, often from an un-updated counter, a wrong comparison, or a retry with no cap. Symptoms are 100% CPU, a frozen UI, or a stall timeout; add iteration limits and logging around suspect loops.',
    proExplain_zh:
      '控制流永远到达不了终止条件，常见原因是计数器没有更新、比较条件写错，或重试没有上限。表现为 CPU 占满、界面卡死或触发停滞超时；可在可疑循环处加上迭代上限和日志。',
    related: ['timeout', 'deadlock', 'out-of-memory', 'logging'],
  },
  {
    id: 'deadlock',
    term: 'Deadlock',
    category: 'errors',
    oneLiner_en: 'Two or more tasks each wait for something the other holds, so none can continue.',
    oneLiner_zh: '两个或多个任务各自等待对方占用的资源，结果谁都无法继续。',
    plainExplain_en:
      'Like two people in a narrow hallway each politely waiting for the other to step aside. Stopping and restarting one side clears it; for a lasting fix, have every task take shared resources in the same order.',
    plainExplain_zh:
      '就像两个人在窄走廊里互相客气地等对方先让路。停止并重启其中一方即可解开；要彻底解决，应让所有任务按相同顺序获取共享资源。',
    proExplain_en:
      'A cycle in the wait-for graph: each party holds a lock and blocks on another lock held by the next. Prevent it with a global lock order, timeouts on lock acquisition, or designs that avoid holding several locks at once. Processes waiting on each other\'s full pipes are a common variant.',
    proExplain_zh:
      '等待图中出现环：每一方都持有一把锁，同时阻塞在下一方持有的另一把锁上。可通过全局统一的加锁顺序、获取锁时设置超时，或避免同时持有多把锁的设计来预防。进程之间互相等待对方写满的管道也是一种常见变体。',
    related: ['race-condition', 'concurrency', 'file-locked', 'timeout', 'infinite-loop'],
  },
  {
    id: 'quota-exceeded',
    term: 'Quota Exceeded',
    category: 'errors',
    oneLiner_en: 'An account has used up its allowance of requests, tokens, or spend for the current period.',
    oneLiner_zh: '账号在当前周期内的请求、token 或费用额度已经用完。',
    plainExplain_en:
      'Like a monthly phone data plan that has run out. Wait for the allowance to reset, raise the limit in the provider settings, or switch the role to another provider.',
    plainExplain_zh:
      '就像手机的月流量用完了。等额度重置，在服务商设置中提高上限，或把该角色切换到另一家服务商。',
    proExplain_en:
      'A hard usage cap on a subscription or API key, distinct from a short rate limit because waiting seconds will not clear it. VibeBaton detects quota messages from CLI drivers, puts the role into quota cooldown, and continues through the fallback chain where one is configured.',
    proExplain_zh:
      '订阅或 API 密钥上的硬性用量上限；与短时速率限制不同，等几秒钟并不能解除。VibeBaton 会识别 CLI 驱动输出的配额信息，让该角色进入配额冷却，并在配置了回退链时沿链继续执行。',
    related: ['rate-limit', '429', 'quota-cooldown', 'subscription-plan', 'fallback-chain'],
  },
];
