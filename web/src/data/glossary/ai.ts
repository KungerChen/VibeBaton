import type { GlossaryEntry } from './types';

export const AI_TERMS: GlossaryEntry[] = [
  {
    id: 'llm',
    term: 'LLM',
    category: 'ai',
    oneLiner_en: 'A large language model: the AI that reads text and writes text, including code.',
    oneLiner_zh: '大语言模型：能够阅读并生成文字（包括代码）的 AI。',
    plainExplain_en:
      'Think of a very well-read assistant who has studied a huge library of books and code. It predicts a helpful continuation of whatever you give it, which is powerful but means its work should always be checked by tests.',
    plainExplain_zh:
      '可以把它想成一位读过海量书籍和代码的助手。它会根据你给的内容续写出有用的回答，能力很强，但也正因如此，它的产出始终需要用测试来检验。',
    proExplain_en:
      'A transformer-based neural network trained on large text corpora to predict the next token. VibeBaton treats each LLM as a provider behind a role (planner, executor, reviewer) and never accepts its output without the mechanical gate and an independent review.',
    proExplain_zh:
      '基于 Transformer 架构、在大规模语料上训练以预测下一个 token 的神经网络。VibeBaton 把每个 LLM 视为某个角色（规划者、执行者、评审者）背后的供应方，且其输出必须经过机械门禁和独立评审才会被采纳。',
    related: ['token', 'model', 'prompt', 'hallucination', 'provider'],
  },
  {
    id: 'token',
    term: 'Token',
    category: 'ai',
    oneLiner_en: 'The small chunk of text an AI model reads and writes, and the unit it is billed by.',
    oneLiner_zh: 'AI 模型读写文字的最小单位，也是计费的单位。',
    plainExplain_en:
      'Models do not read whole words; they read pieces of words, a bit like syllables. A short English word is usually one token, and a Chinese character is often one or two. Both what you send and what comes back are counted, which is why long tasks cost more.',
    plainExplain_zh:
      '模型并不是按整词阅读，而是按词的片段来读，有点像音节。一个简短的英文单词通常是一个 token，一个汉字往往是一到两个。你发送的内容和模型返回的内容都会计数，所以任务越长，花费越多。',
    proExplain_en:
      'A unit produced by the model tokenizer (typically byte-pair encoding). Context limits and pricing are expressed in tokens, usually as USD per million input, output, and cached-input tokens. VibeBaton telemetry sums these per task to report cost in the battle report.',
    proExplain_zh:
      '由模型分词器（通常是 BPE 字节对编码）切分出的单位。上下文上限和价格都以 token 计，通常按每百万输入、输出和缓存输入 token 的美元价格计费。VibeBaton 的遥测会按任务累加这些用量，并在战报中给出成本。',
    related: ['input-tokens', 'output-tokens', 'context-window', 'prompt-caching', 'llm'],
  },
  {
    id: 'context-window',
    term: 'Context Window',
    category: 'ai',
    oneLiner_en: 'The maximum amount of text a model can hold in view at once, counted in tokens.',
    oneLiner_zh: '模型一次能同时看到的文本上限，以 token 计。',
    plainExplain_en:
      'Think of a desk that fits only so many papers: everything the model needs for the current reply must fit on it, including the conversation so far, the files you pasted, and the answer it is writing. Once the desk is full, older papers fall off, which is why a long session can forget an early instruction.',
    plainExplain_zh:
      '可以想象成一张只能摆下有限纸张的书桌：模型写这次回答所需的全部材料都必须放得下，包括此前的对话、你贴进来的文件和它正在写的答案。桌面一满，旧纸张就会掉下去，所以会话很长时，早期的一条指示就可能被忘掉。',
    proExplain_en:
      'The fixed token budget covering input plus generated output for a single inference call. A model with a 200k-token window does not remember beyond it; engines may truncate, summarize, or retrieve older context. VibeBaton sizes each task prompt to fit the configured model and starts fresh worker sessions so a long DAG never silently loses the RFC.',
    proExplain_zh:
      '单次推理调用中，输入与生成输出共用的一份固定 token 预算。窗口为 200k token 的模型无法记住窗口之外的内容；引擎可能会截断、摘要或检索旧上下文。VibeBaton 按所配置模型的窗口裁剪每个任务的提示词，并为每个任务开启新的工作会话，避免长 DAG 运行悄悄丢掉 RFC。',
    related: ['token', 'input-tokens', 'output-tokens', 'prompt-caching', 'llm'],
  },
  {
    id: 'prompt',
    term: 'Prompt',
    category: 'ai',
    oneLiner_en:
      'The text you give a model: the instruction, the context it needs, and the output format you want.',
    oneLiner_zh: '你交给模型的文字：要做的事、需要的背景，以及你期望的输出格式。',
    plainExplain_en:
      'Like a work order for a contractor. "Fix the sink" leaves room for interpretation; "replace the washer under the kitchen sink, use the spare in the drawer, and test for leaks" gets the job done. The model can only act on what the prompt makes clear.',
    plainExplain_zh:
      '就像给施工队的任务单。只写“修一下水槽”会留下很多解释空间；写明“换掉厨房水槽下面的垫圈，用抽屉里的备件，然后检查是否漏水”，事情才能做成。模型只能根据提示词里说清楚的内容行事。',
    proExplain_en:
      'The complete input for one model call, assembled from the system prompt, conversation history, task description, file excerpts, and output contract. VibeBaton generates prompts from per-role templates and keeps them deterministic enough that a failing task can be reproduced with the same input.',
    proExplain_zh:
      '一次模型调用的完整输入，由系统提示词、对话历史、任务描述、文件片段和输出约定拼装而成。VibeBaton 按角色模板生成提示词，并尽量保持确定性，使失败的任务可以用相同的输入复现。',
    related: ['system-prompt', 'few-shot', 'chain-of-thought', 'structured-output', 'prompt-caching'],
  },
  {
    id: 'system-prompt',
    term: 'System Prompt',
    category: 'ai',
    oneLiner_en:
      'The standing instruction that sets the role, rules, and output format a model follows for the whole conversation.',
    oneLiner_zh: '在整段对话中持续生效的指令，用来设定模型的角色、规则和输出格式。',
    plainExplain_en:
      'Think of the difference between a job description and a single task: the system prompt is the job description, always in force, while your messages are the individual tasks. It is where rules such as "you are a careful reviewer, and you never edit files you were not given" belong.',
    plainExplain_zh:
      '可以想想岗位说明和单次任务的区别：系统提示词就是始终生效的岗位说明，而你发的消息是一件件具体任务。“你是一名细致的评审者，绝不修改没有交给你的文件”这类规则就应写在这里。',
    proExplain_en:
      'A high-priority message prepended by the client, separate from user turns, that shapes every response in the session. VibeBaton gives each role (planner, executor, reviewer) its own system prompt spelling out allowed actions, the mechanical gate, and the required response schema; role rules are enforced again by the engine because prompts alone are not a security boundary.',
    proExplain_zh:
      '由客户端置于对话最前的高优先级消息，与用户轮次分开，影响该会话的每次回复。VibeBaton 为每个角色（规划者、执行者、评审者）准备独立的系统提示词，写明允许的动作、机械门禁和必须遵循的响应 schema；同时引擎会再次强制执行角色规则，因为提示词本身并不是安全边界。',
    related: ['prompt', 'role', 'guardrails', 'structured-output', 'llm'],
  },
  {
    id: 'temperature',
    term: 'Temperature',
    category: 'ai',
    oneLiner_en: 'A setting that controls how random or predictable the word choices of a model are.',
    oneLiner_zh: '控制模型选词随机程度的参数。',
    plainExplain_en:
      'Think of a dial between "give me the standard answer" and "surprise me". Low temperature keeps output close to the most likely wording, which suits code and exact formats; high temperature produces more variety but also more drift. VibeBaton runs implementation and review at low temperature so results are reproducible.',
    plainExplain_zh:
      '可以看成一个旋钮，一端是“给我标准答案”，另一端是“给我点惊喜”。温度低时输出贴近最可能的措辞，适合代码和严格格式；温度高时变化更多，但也更容易跑偏。VibeBaton 在实现和评审环节使用低温度，让结果可复现。',
    proExplain_en:
      'A sampling parameter that scales the logits before the softmax, flattening (higher values) or sharpening (lower values, approaching greedy decoding) the next-token distribution; 0 is not guaranteed deterministic on every provider. VibeBaton pins a low temperature per role so two runs of the same task differ only where the code genuinely allows it.',
    proExplain_zh:
      '一种采样参数，在 softmax 之前缩放 logits，从而拉平（值较高）或锐化（值较低，趋近贪心解码）下一个 token 的概率分布；并非所有供应方都能保证 0 时完全确定。VibeBaton 为每个角色固定低温度，使同一任务的两次运行只在代码本身允许的地方有差异。',
    related: ['inference', 'model', 'reasoning-effort', 'hallucination'],
  },
  {
    id: 'hallucination',
    term: 'Hallucination',
    category: 'ai',
    oneLiner_en: 'When a model states something false with the same confidence as something true.',
    oneLiner_zh: '模型把不真实的内容说得和真的一样。',
    plainExplain_en:
      'A model predicts plausible text, not verified facts. It may invent a function that does not exist, cite a file it never read, or claim a test passed. That is why every claim needs a check the model cannot fake, such as running the tests or opening the file.',
    plainExplain_zh:
      '模型生成的是看起来合理的文字，而不是经过核实的事实。它可能编造一个并不存在的函数、引用从未读过的文件，或者声称测试已经通过。所以每个结论都需要一个模型无法伪造的检查，比如真正运行测试或打开文件核对。',
    proExplain_en:
      'Fluent, confident output that is not grounded in the input or the world, arising because the model optimizes for likely continuations rather than truth. VibeBaton counters it mechanically: executors must run a real verification command, reviewers compare the diff against the RFC, and the final gate re-runs checks instead of trusting a summary.',
    proExplain_zh:
      '流畅而自信、却没有输入或事实依据的输出，根源在于模型优化的是“最可能的续写”而不是真实性。VibeBaton 用机械手段对抗它：执行者必须运行真实的验证命令，评审者将 diff 与 RFC 对照，终审门禁会重新运行检查，而不是相信一段总结。',
    related: ['guardrails', 'evals', 'mechanical-gate', 'ai-review', 'llm'],
  },
  {
    id: 'agent',
    term: 'Agent',
    category: 'ai',
    oneLiner_en: 'An AI that can take actions in a loop, not just answer a single question.',
    oneLiner_zh: '能够循环执行动作、而不只是回答单个问题的 AI。',
    plainExplain_en:
      'A chatbot replies with text; an agent goes further: it reads a file, runs a command, looks at the result, and decides what to do next, repeating until the task is done or it gets stuck. More autonomy means the guardrails around it matter more.',
    plainExplain_zh:
      '聊天机器人只回复文字，智能体则更进一步：它读取文件、运行命令、查看结果，再决定下一步，如此循环，直到任务完成或卡住。自主性越强，围绕它的护栏就越重要。',
    proExplain_en:
      'A loop of model call, tool call, observation, and next model call, with the tools and stopping conditions defined by the harness. In VibeBaton the executor is an agent bounded by its task allowed paths, a verification command, and a turn budget; when it exceeds those, the task fails rather than improvising.',
    proExplain_zh:
      '由“模型调用、工具调用、观察结果、再次调用模型”构成的循环，可用工具和停止条件由外层框架定义。在 VibeBaton 中，执行者这一智能体受任务允许路径、验证命令和轮次预算约束；一旦越界，任务会直接失败，而不是即兴发挥。',
    related: ['coding-agent', 'tool-call', 'multi-agent', 'orchestration', 'guardrails'],
  },
  {
    id: 'tool-call',
    term: 'Tool Call',
    category: 'ai',
    oneLiner_en: 'A structured request from a model asking the program around it to run a function.',
    oneLiner_zh: '模型发出的结构化请求，让外层程序执行某个函数。',
    plainExplain_en:
      'The model cannot actually open files or run tests by itself; it can only ask. A tool call is that request, filled in like a form: which tool, which arguments. The program runs it and hands the result back so the model can continue.',
    plainExplain_zh:
      '模型并不能真的打开文件或运行测试，它只能提出请求。工具调用就是这张填好的表单：用哪个工具、传什么参数。外层程序执行后把结果交回，模型再继续下一步。',
    proExplain_en:
      'A model output that names a tool and supplies JSON arguments matching that tool schema; the client executes it and appends the result as a tool message. VibeBaton exposes a small, audited tool set (read, edit, run command) and rejects arguments that fall outside the task allowed paths instead of executing them.',
    proExplain_zh:
      '模型输出中指明某个工具并提供符合该工具 schema 的 JSON 参数；客户端执行后，把结果作为工具消息追加回上下文。VibeBaton 只暴露一组小而经过审计的工具（读取、编辑、运行命令），并会拒绝超出任务允许路径的参数，而不是照单执行。',
    related: ['mcp', 'agent', 'structured-output', 'sandbox', 'allowed-paths'],
  },
  {
    id: 'mcp',
    term: 'MCP',
    category: 'ai',
    oneLiner_en:
      'Model Context Protocol: a standard way for AI clients to discover and call external tools.',
    oneLiner_zh: '模型上下文协议：AI 客户端发现并调用外部工具的一套标准接口。',
    plainExplain_en:
      'Before MCP, every AI integration needed its own custom plug. MCP is a common socket: a server publishes the tools and data it offers, and any compatible client can use them without bespoke glue. It is how an agent can reach a database, a repository host, or an issue tracker.',
    plainExplain_zh:
      '在使用 MCP 之前，每个 AI 集成都需要单独做一套定制接口。MCP 就像一个通用插座：服务端公布自己提供的工具和数据，任何兼容的客户端都能直接使用，不必再写专门的胶水代码。智能体正是通过它连接数据库、代码托管平台或问题跟踪系统。',
    proExplain_en:
      'An open JSON-RPC protocol in which servers expose resources, prompts, and tools, and clients connect over stdio or HTTP. VibeBaton can consume MCP servers as tool providers for its agents while keeping its own file sandbox and verification gate in control of what actually changes.',
    proExplain_zh:
      '一种开放的 JSON-RPC 协议：服务端对外暴露资源、提示词和工具，客户端通过 stdio 或 HTTP 连接。VibeBaton 可以把 MCP 服务端作为智能体的工具来源，同时仍由自身的文件沙箱和验证门禁控制真正发生的改动。',
    related: ['tool-call', 'agent', 'api', 'sandbox'],
  },
  {
    id: 'model',
    term: 'Model',
    matchCase: true,
    category: 'ai',
    oneLiner_en: 'The trained neural network whose weights determine how an AI responds.',
    oneLiner_zh: '训练好的神经网络，其权重决定了 AI 如何回应。',
    plainExplain_en:
      'The model is the brain; the prompt is what you say to it, and the harness is the hands and rules around it. Different models trade speed, price, and reasoning depth, so choosing one is like choosing a vehicle: a scooter for a short errand, a truck for a big load.',
    plainExplain_zh:
      '模型是大脑，提示词是你对它说的话，外面的框架则是手和规则。不同模型在速度、价格和推理深度之间取舍，选模型就像选交通工具：短途办事骑小电动车，搬大件则要卡车。',
    proExplain_en:
      'A specific checkpoint with a name, a context limit, a price table, and supported features such as tools or vision. VibeBaton records the exact model id on every task run, routes work to models by role and budget profile, and refuses to mix results from an unrecorded model into the battle report.',
    proExplain_zh:
      '一个具体的模型检查点，拥有名称、上下文上限、价格表，以及工具调用或视觉等特性。VibeBaton 会在每次任务运行中记录确切的模型 id，按角色和预算方案把工作路由到不同模型，并拒绝把来源不明的模型结果混入战报。',
    related: ['llm', 'provider', 'model-routing', 'benchmark', 'context-window'],
  },
  {
    id: 'reasoning-effort',
    term: 'Reasoning Effort',
    category: 'ai',
    oneLiner_en:
      'A per-request setting for how much deliberate thinking a model spends before answering.',
    oneLiner_zh: '每次请求时用来控制模型在回答前投入多少推理的档位。',
    plainExplain_en:
      'Some tasks need a quick answer, others need working through several steps. This is a dial for that: higher effort buys more internal reasoning and better plans, at the cost of latency and tokens. A routine rename does not need the same setting as an architecture decision.',
    plainExplain_zh:
      '有些任务只需快速回答，有些则需要逐步推演。这个参数就是对应的旋钮：调高会花更多内部推理，换来更好的计划，代价是延迟和 token。给变量改个名字和做一次架构决策，不需要同一档位。',
    proExplain_en:
      'A provider-level control (low, medium, high, or a token budget for reasoning) that changes how many hidden reasoning tokens are generated before the visible answer. VibeBaton maps task tier to effort: routine tasks stay cheap and fast, while critical planning and review tasks may spend more.',
    proExplain_zh:
      '供应方层面的控制项（低、中、高，或推理 token 预算），决定在可见答案之前生成多少隐藏推理 token。VibeBaton 将任务层级映射到推理档位：常规任务保持便宜和快速，关键的规划与评审任务则可以投入更多。',
    related: ['inference', 'temperature', 'model-routing', 'critical-task'],
  },
  {
    id: 'inference',
    term: 'Inference',
    category: 'ai',
    oneLiner_en: 'The act of running a trained model to produce an output, as opposed to training it.',
    oneLiner_zh: '让训练好的模型产出结果的过程，与训练模型相对。',
    plainExplain_en:
      'Training is how a model learns; inference is how it is used. Every prompt you send starts an inference: the model reads the tokens and produces the next ones one step at a time. You pay for inference by the token, and it is the slow part of an agent run.',
    plainExplain_zh:
      '训练是模型学习的过程，推理则是使用模型的过程。你发送的每个提示词都会触发一次推理：模型读取 token，再一步一步生成后续内容。推理按 token 计费，也是智能体运行中较慢的环节。',
    proExplain_en:
      'The forward pass that turns input tokens into a probability distribution over the next token, repeated until a stop condition. VibeBaton calls inference through provider APIs or local CLI drivers, measures latency and token counts per call, and treats a timed-out inference as a failed attempt eligible for retry or fallback.',
    proExplain_zh:
      '把输入 token 转换为下一个 token 概率分布的前向计算，并重复执行直到遇到停止条件。VibeBaton 通过供应方 API 或本地 CLI 驱动发起推理，逐次记录延迟和 token 数，并把超时的推理视为失败尝试，交给重试或回退处理。',
    related: ['llm', 'token', 'latency', 'streaming', 'provider'],
  },
  {
    id: 'fine-tuning',
    term: 'Fine-Tuning',
    category: 'ai',
    oneLiner_en: 'Further training a base model on your own examples so it better fits a specific task.',
    oneLiner_zh: '在基础模型上用你自己的样例继续训练，使它更贴合特定任务。',
    plainExplain_en:
      'A general model has read the whole library; fine-tuning is like giving it a focused apprenticeship at your company. It can teach a style or a narrow skill, but it cannot reliably add fresh facts or replace clear instructions and good tools.',
    plainExplain_zh:
      '通用模型像是读完了整座图书馆，微调则像让它在你的公司做一段有针对性的实习。它能教会模型一种风格或一项窄技能，但无法可靠地灌入新鲜事实，也不能替代清楚的指令和好用的工具。',
    proExplain_en:
      'Supervised training that updates some or all weights on a curated dataset, producing a new model id. It is expensive, needs versioned data, and must be evaluated like any other model. VibeBaton prefers prompts, tools, and evals first; if a fine-tuned model is used, it is pinned by id and evaluated against the same benchmark suite.',
    proExplain_zh:
      '在精选数据集上更新部分或全部权重、产出一个新模型 id 的监督训练。它成本高、需要版本化的数据，并且必须像其他模型一样接受评估。VibeBaton 优先使用提示词、工具和评测；若确实使用微调模型，会固定其 id，并用同一套基准测试来评估。',
    related: ['model', 'embedding', 'evals', 'benchmark', 'llm'],
  },
  {
    id: 'embedding',
    term: 'Embedding',
    category: 'ai',
    oneLiner_en:
      'A list of numbers that represents the meaning of a piece of text, so similar text ends up close together.',
    oneLiner_zh: '用一串数字给文本的含义“定位”，意思相近的话会被放在彼此靠近的位置。',
    plainExplain_en:
      'Imagine filing every sentence by its position on a giant map of meaning: "reset a password" and "recover login" land near each other even though they share no keywords. Embeddings make it possible to search by meaning rather than exact wording.',
    plainExplain_zh:
      '可以想象把每句话按位置贴到一张巨大的“语义地图”上：“重置密码”和“找回登录”即使没有共同关键词，也会落在相近的位置。嵌入让搜索可以按含义进行，而不必逐字匹配。',
    proExplain_en:
      'A dense vector produced by an embedding model, compared with cosine similarity or a dot product. VibeBaton can embed specs, logs, and prior case bundles to retrieve the few passages that fit a task context window, which keeps prompts small and relevant.',
    proExplain_zh:
      '由嵌入模型生成的稠密向量，用余弦相似度或点积进行比较。VibeBaton 可以嵌入规格文档、日志和既往案例包，从中检索出少量能塞进任务上下文窗口的相关段落，让提示词既小又切题。',
    related: ['rag', 'context-window', 'model', 'knowledge-cutoff'],
  },
  {
    id: 'rag',
    term: 'RAG',
    category: 'ai',
    oneLiner_en:
      'Retrieval-augmented generation: fetching relevant documents and putting them in the prompt before the model answers.',
    oneLiner_zh: '检索增强生成：先找出相关文档放进提示词，再让模型作答。',
    plainExplain_en:
      'Instead of relying on what the model happens to remember, you hand it the right pages open on the desk. The answer can then cite current project files or fresh documentation, and you can check the sources. The hard part is retrieval: fetch the wrong pages and the answer is confidently wrong.',
    plainExplain_zh:
      '与其依赖模型恰好记住了什么，不如把正确的资料摊开在它面前。这样答案可以引用当前的项目文件或最新文档，你也能核对来源。难点在于检索：找错了页面，答案就会自信地错下去。',
    proExplain_en:
      'A pipeline of chunk, embed, index, retrieve, rerank, and prompt. Retrieval quality bounds answer quality, so retrieved chunks always carry their file paths and the model must cite them instead of paraphrasing from memory. VibeBaton uses the same pattern to give the planner the relevant RFC sections and prior battle reports.',
    proExplain_zh:
      '由切块、嵌入、建索引、检索、重排和拼入提示词组成的流水线。检索质量决定答案质量，因此每个检索片段都携带文件路径，模型必须引用来源而不是凭记忆转述。VibeBaton 用同样的方式把相关 RFC 章节和既往战报提供给规划者。',
    related: ['embedding', 'context-window', 'knowledge-cutoff', 'hallucination'],
  },
  {
    id: 'multi-agent',
    term: 'Multi-Agent',
    category: 'ai',
    oneLiner_en: 'A setup where several AI agents work on the same job in different roles or in parallel.',
    oneLiner_zh: '让多个 AI 智能体分角色或并行处理同一项工作的方式。',
    plainExplain_en:
      'One agent doing everything has to be planner, coder, and reviewer at once, and reviewing its own work is weak. Splitting the job lets one plan, one implement, and one check, like a small team. The cost is coordination: agents can duplicate work or disagree.',
    plainExplain_zh:
      '如果一个智能体包揽全部工作，它就要同时做规划、写代码和评审，而自己审自己效果有限。拆开之后，一个负责规划、一个负责实现、一个负责检查，像一支小团队。代价是协调成本：智能体之间可能重复劳动或意见不一致。',
    proExplain_en:
      'An architecture with separate agent instances, each with its own prompt, context, and permissions, connected by a coordinator or shared artifacts. VibeBaton runs planner, executor, and reviewer as distinct roles and forbids the executor from approving its own diff, which turns independence into a property of the system rather than a hope.',
    proExplain_zh:
      '一种由多个独立智能体实例组成的架构，每个实例有自己的提示词、上下文和权限，通过协调器或共享产物连接。VibeBaton 把规划者、执行者和评审者设为不同角色，并禁止执行者批准自己的 diff，让“独立性”成为系统属性而不是一种期望。',
    related: ['agent', 'orchestration', 'role', 'ai-review', 'specialist-panel'],
  },
  {
    id: 'orchestration',
    term: 'Orchestration',
    category: 'ai',
    oneLiner_en:
      'The coordination layer that decides which agent or model runs when, and with what input.',
    oneLiner_zh: '负责决定何时由哪个智能体或模型执行、输入是什么的协调层。',
    plainExplain_en:
      'An orchestra sounds chaotic without a conductor. Orchestration hands each worker its part, starts independent parts together, waits for the ones that must finish first, and collects the results. In an AI system it is the difference between a pile of calls and a completed job.',
    plainExplain_zh:
      '没有指挥的乐团只会乱成一团。编排负责把各自的声部交给每个执行者，让互不依赖的部分同时开始，等待必须先完成的部分，最后收拢结果。在 AI 系统里，它决定了是一堆零散调用还是一个真正完成的任务。',
    proExplain_en:
      'Scheduling, dependency resolution, retries, budget enforcement, and result aggregation across model calls and agent runs. VibeBaton implements it in the plan engine: it walks the Plan DAG, applies concurrency limits and fallback chains, and records every step in the battle report so a failed orchestration is diagnosable.',
    proExplain_zh:
      '跨模型调用和智能体运行的调度、依赖解析、重试、预算控制与结果汇总。VibeBaton 在计划引擎中实现这些能力：遍历 Plan DAG，应用并发上限和回退链，并把每一步记录进战报，使失败的编排可以诊断。',
    related: ['multi-agent', 'plan-dag', 'fallback-chain', 'agent', 'provider'],
  },
  {
    id: 'coding-agent',
    term: 'Coding Agent',
    category: 'ai',
    oneLiner_en:
      'An AI agent equipped to read and edit a codebase, run commands, and iterate until tests pass.',
    oneLiner_zh: '能够读写代码库、运行命令，并反复迭代直到测试通过的 AI 智能体。',
    plainExplain_en:
      'A coding assistant suggests a snippet; a coding agent opens the file, makes the edit, runs the tests, reads the failure, and tries again. That loop is powerful, and it needs a clear scope and a real test suite to stay honest.',
    plainExplain_zh:
      '代码助手只给出片段，代码智能体则会打开文件、完成修改、运行测试、读取失败信息，然后再试一次。这个循环很有力，但也需要清晰的范围和真实的测试套件，才能保证它不偏离目标。',
    proExplain_en:
      'An agent whose tools include file read and write plus shell execution inside a working tree, with a loop bounded by a verification command. VibeBaton runs coding agents in isolated worktrees, limits each to its task allowed paths, and accepts the change only when the mechanical gate passes and a separate reviewer approves.',
    proExplain_zh:
      '一类智能体，其工具包括在工作树内读写文件和执行 shell，循环以验证命令为边界。VibeBaton 把代码智能体放在隔离的 worktree 中运行，把每个智能体限制在任务的允许路径内，并且只有机械门禁通过且独立评审者批准后才接受改动。',
    related: ['agent', 'worktree', 'allowed-paths', 'mechanical-gate', 'vibe-coding'],
  },
  {
    id: 'subscription-plan',
    term: 'Subscription Plan',
    category: 'ai',
    oneLiner_en:
      'A fixed monthly price for a service that includes a usage allowance, instead of paying per token.',
    oneLiner_zh: '按月固定付费、包含一定用量的服务方案，而不是按 token 单独计费。',
    plainExplain_en:
      'There are two ways to buy electricity: prepaid credit that runs out, or a monthly plan with an allowance. Subscription plans for AI tools usually set limits on messages or compute, and they can be much cheaper per token than pay-as-you-go, as long as your usage fits inside them.',
    plainExplain_zh:
      '买电有两种方式：预付费额度用完为止，或者按月套餐包一定用量。AI 工具的订阅方案通常限制消息数或计算量；只要你的用量落在额度内，单位 token 的成本往往比按量付费低得多。',
    proExplain_en:
      'Provider billing where a flat fee covers a quota of requests or compute over a period. VibeBaton records the billing kind for each provider account so budget checks compare against the right unit, and a quota-cooldown pauses work instead of failing when a plan allowance runs out.',
    proExplain_zh:
      '供应方的一种计费方式：固定费用覆盖一段时间内的请求或计算额度。VibeBaton 会记录每个供应方账户的计费类型，使预算检查使用正确的单位；当套餐额度耗尽时，配额冷却会暂停工作，而不是直接让任务失败。',
    related: ['api-key', 'provider', 'budget-profile', 'quota-cooldown', 'rate-limit'],
  },
  {
    id: 'api-key',
    term: 'API Key',
    category: 'ai',
    oneLiner_en: 'A secret string that identifies your account and authorizes calls to a provider API.',
    oneLiner_zh: '标识你的账户并授权调用供应方接口的一串密钥。',
    plainExplain_en:
      'Like a keycard for a building: it identifies you and gives you access, so anyone holding it can spend your account and see your data. Keep it out of the code and out of the repository, and rotate it if it ever gets printed in a log.',
    plainExplain_zh:
      '就像一栋楼的门禁卡：它确认你的身份并放你通行，因此拿到它的人也能花你的钱、看你的数据。不要把它写进代码或提交到仓库；一旦它出现在日志里，就应尽快更换。',
    proExplain_en:
      'A bearer credential sent in headers or environment variables and scoped to a provider project. VibeBaton reads keys from environment variables or the OS credential store, never writes them to the RFC or logs, and records only masked fingerprints so a leaked key can be traced without exposing it.',
    proExplain_zh:
      '通过请求头或环境变量发送、作用域限定到供应方项目的持有者凭证。VibeBaton 从环境变量或操作系统凭据存储读取密钥，绝不写入 RFC 或日志，只记录脱敏指纹，以便在密钥泄露时追溯而不暴露密钥本身。',
    related: ['provider', 'environment-variable', 'auth-error', 'permission-denied'],
  },
  {
    id: 'prompt-caching',
    term: 'Prompt Caching',
    category: 'ai',
    oneLiner_en:
      'Reusing the saved computation a provider keeps for a repeated prompt prefix, which lowers cost and latency.',
    oneLiner_zh: '复用服务端已保存的提示词前缀计算，从而降低费用与延迟。',
    plainExplain_en:
      'If every task repeats the same long preamble, you should not pay to process it every time. Caching keeps that part ready on the server and only charges the new text, like keeping a kettle hot instead of boiling it from cold for each cup. It works best when the stable text comes first.',
    plainExplain_zh:
      '如果每个任务都重复同一段很长的开场内容，就不该每次都重新付钱处理它。缓存会让这部分在服务端保持就绪，只对新文字计费，好比让水壶一直保温，而不是每杯都从冷水烧起。把稳定不变的文字放在前面效果最好。',
    proExplain_en:
      'A provider-side key-value cache keyed on an exact token prefix, usually billed at a fraction of normal input tokens on a hit and expiring after minutes. VibeBaton puts the system prompt and RFC context first and task-specific text last, so agents across a DAG share cache hits; the battle report separates cached and fresh input tokens.',
    proExplain_zh:
      '供应方侧的键值缓存，按完全相同的 token 前缀命中，通常按正常输入 token 价格的一小部分计费，并在数分钟后过期。VibeBaton 把系统提示词和 RFC 背景放在最前、任务专属文字放在最后，使同一 DAG 中的多个智能体共享缓存命中；战报会区分缓存输入与新增输入 token。',
    related: ['token', 'input-tokens', 'context-window', 'latency', 'provider'],
  },
  {
    id: 'input-tokens',
    term: 'Input Tokens',
    category: 'ai',
    oneLiner_en: 'The tokens you send to a model: instructions, context, and conversation so far.',
    oneLiner_zh: '你发送给模型的 token：指令、背景以及已有对话。',
    plainExplain_en:
      'Every word you put in front of the model is billed, including the parts it has seen before. A long RFC, several files, and a chat history add up quickly, which is why trimming context and caching repeated prefixes saves real money.',
    plainExplain_zh:
      '你放到模型面前的每个字都会计费，包括它此前已经看过的部分。一份很长的 RFC、多个文件和一段对话历史很快就会累积起来，所以精简上下文、缓存重复前缀能实实在在省钱。',
    proExplain_en:
      'Prompt tokens counted on each inference request, priced separately from output and usually the larger share of cost in agent loops. VibeBaton estimates them before dispatch, records actual counts per task, and charges cached input at the lower rate when the provider reports it.',
    proExplain_zh:
      '每次推理请求中计入的提示词 token，与输出分别计价，在智能体循环中往往占总成本的大头。VibeBaton 在派发前估算用量，逐任务记录实际数量，并在供应方报告缓存命中时按较低单价计算缓存输入。',
    related: ['token', 'output-tokens', 'context-window', 'prompt-caching', 'budget-profile'],
  },
  {
    id: 'output-tokens',
    term: 'Output Tokens',
    category: 'ai',
    oneLiner_en: 'The tokens a model generates in its reply, usually priced higher than input tokens.',
    oneLiner_zh: '模型在回复中生成的 token，单价通常高于输入 token。',
    plainExplain_en:
      'Writing is slower and more expensive than reading. Output tokens are produced one at a time, so they dominate latency, and providers often charge several times the input rate. Asking for a concise diff or a short report is both faster and cheaper.',
    plainExplain_zh:
      '写比读更慢也更贵。输出 token 是一个一个生成的，因此主导了延迟，供应方的收费常常是输入单价的数倍。要求模型给出简洁的 diff 或简短报告，既快又省钱。',
    proExplain_en:
      'Generated tokens, including hidden reasoning tokens on models that bill them, bounded by the max-output setting. VibeBaton caps output per role, asks for patches and structured summaries instead of essays, and sums output tokens per task to compare cost against the budget profile.',
    proExplain_zh:
      '模型生成的 token，在某些模型上还包括计费的隐藏推理 token，受最大输出设置限制。VibeBaton 为每个角色限制输出长度，要求提供补丁和结构化摘要而不是长篇大论，并按任务汇总输出 token，以对照预算方案检查成本。',
    related: ['token', 'input-tokens', 'streaming', 'reasoning-effort', 'budget-profile'],
  },
  {
    id: 'streaming',
    term: 'Streaming',
    category: 'ai',
    oneLiner_en:
      'Receiving a model reply token by token as it is generated, instead of waiting for the whole answer.',
    oneLiner_zh: '在模型生成过程中逐块接收回复，而不是等整段答案生成完。',
    plainExplain_en:
      'Without streaming, the screen stays empty until the answer is done; with it, text appears as it is written, like watching someone type. It does not change the final content or the price, but it makes long answers feel far more responsive and lets a UI show progress.',
    plainExplain_zh:
      '没有流式输出时，屏幕要等答案全部生成完才有内容；有了它，文字会像有人正在打字一样逐段出现。它不改变最终内容或价格，却能让长答案的等待感大大降低，也方便界面展示进度。',
    proExplain_en:
      'Server-sent events or chunked responses carrying token deltas plus a final usage message. VibeBaton consumes streams for live task output while still assembling the full text for parsing, and the usage chunk, not the stream end, supplies the authoritative token counts.',
    proExplain_zh:
      '通过服务器发送事件或分块响应传输 token 增量，并在最后附带用量消息。VibeBaton 用流式输出展示任务实时进度，同时仍会拼装完整文本用于解析；权威的 token 数量来自用量块，而不是流结束这一事件。',
    related: ['sse', 'output-tokens', 'response', 'latency'],
  },
  {
    id: 'structured-output',
    term: 'Structured Output',
    category: 'ai',
    oneLiner_en:
      'A model reply constrained to a predefined shape, such as JSON matching a schema, instead of free text.',
    oneLiner_zh: '把模型回复限制为预定义结构（例如符合 schema 的 JSON），而不是自由文本。',
    plainExplain_en:
      'Free text is easy for a human to read and hard for a program to use. Asking for a fixed shape, with named fields and allowed values, lets the next step parse the reply without guesswork. It is the difference between a note on a napkin and a filled-in form.',
    plainExplain_zh:
      '自由文本方便人阅读，却让程序难以使用。要求固定结构，即具名字段和允许的取值，下一步就能直接解析回复而不必猜测。这就像餐巾纸上的便条和一张填好的表单的区别。',
    proExplain_en:
      'Constrained decoding or a validated response schema (JSON Schema, typed tool arguments) where the provider guarantees the shape or the client rejects and retries. VibeBaton requires planner and reviewer replies to match a schema, so the engine can schedule tasks and read verdicts without brittle text parsing.',
    proExplain_zh:
      '约束解码或经过校验的响应 schema（JSON Schema、带类型的工具参数），由供应方保证结构，或由客户端拒绝并重试。VibeBaton 要求规划者和评审者的回复符合 schema，使引擎无需脆弱的文本解析就能调度任务、读取结论。',
    related: ['json-mode', 'json', 'schema', 'tool-call', 'guardrails'],
  },
  {
    id: 'json-mode',
    term: 'JSON mode',
    category: 'ai',
    oneLiner_en: 'A provider setting that asks the model to reply with valid JSON.',
    oneLiner_zh: '供应方提供的一种设置，要求模型以合法 JSON 回复。',
    plainExplain_en:
      'It is a step stronger than a polite instruction: the model is told, by a setting, to produce JSON that parses. That is useful for data exchange, but JSON mode alone may not enforce your exact fields, so checking against a schema is still wise.',
    plainExplain_zh:
      '它比在提示词里客气地要求更进一步：通过设置直接要求模型输出能被解析的 JSON。这对数据交换很有用，但 JSON 模式本身未必能保证字段完全符合你的定义，所以仍应再按 schema 校验一次。',
    proExplain_en:
      'A request flag or response format that constrains decoding to parseable JSON, while strict adherence to a particular schema may require a separate structured-output mode or a validator. VibeBaton enables it where supported and always validates the parsed object before acting on it.',
    proExplain_zh:
      '一种请求标志或响应格式，把解码约束为可解析的 JSON；但要严格符合某个 schema，可能还需要单独的结构化输出模式或校验器。VibeBaton 在支持时启用它，并且在使用解析出的对象之前一定会先校验。',
    related: ['structured-output', 'json', 'schema', 'api'],
  },
  {
    id: 'few-shot',
    term: 'Few-Shot',
    category: 'ai',
    oneLiner_en:
      'Showing a model a few examples of the task inside the prompt so it copies the pattern.',
    oneLiner_zh: '在提示词里给出几个任务示例，让模型照着这个模式做。',
    plainExplain_en:
      'Children learn a game faster by watching a round than by reading the rules. Two or three input and output examples often communicate a format or judgement call better than a paragraph of instructions, and they cost far less than fine-tuning.',
    plainExplain_zh:
      '孩子看别人玩一局，往往比读规则更快学会游戏。两三个输入输出示例，常常比一大段说明更能传达格式或判断标准，而且成本远低于微调。',
    proExplain_en:
      'In-context learning with k labeled demonstrations prepended to the query; zero-shot and one-shot are the k=0 and k=1 cases. VibeBaton keeps a few golden examples in reviewer prompts so verdicts follow one shape, and treats those examples as part of the versioned prompt rather than an afterthought.',
    proExplain_zh:
      '在查询前附上 k 个带标签示例的上下文学习；零样本和单样本分别对应 k=0 和 k=1。VibeBaton 在评审提示词中保留几个黄金示例，使结论遵循统一格式，并把这些示例视为版本化提示词的一部分，而不是临时附加物。',
    related: ['prompt', 'system-prompt', 'golden-example', 'structured-output'],
  },
  {
    id: 'chain-of-thought',
    term: 'Chain of Thought',
    category: 'ai',
    oneLiner_en:
      'Asking a model to work through intermediate steps before giving its final answer.',
    oneLiner_zh: '要求模型先逐步推理，再给出最终答案。',
    plainExplain_en:
      'For arithmetic or multi-step decisions, a person who shows the work makes fewer mistakes than one who answers immediately. Chain-of-thought is the same trick: reasoning first, conclusion last. It helps most on hard problems and can be wasted effort on simple ones.',
    plainExplain_zh:
      '做算术或需要多步判断的事情时，把过程写出来的人往往比张口就答的人错得少。思维链是同一个办法：先推理，后结论。它在难题上收益最大，在简单题上可能只是白费力气。',
    proExplain_en:
      'Eliciting intermediate reasoning tokens before the answer, either by instruction or through built-in reasoning effort. VibeBaton asks for short reasoning in planning and review, then requires a final structured verdict, so the reasoning is visible during a run but never substituted for the verification command.',
    proExplain_zh:
      '通过指令或内置推理档位，在答案之前生成中间推理 token。VibeBaton 在规划和评审中要求简短推理，再给出最终的结构化结论，因此推理过程在运行中可见，但绝不会被用来替代验证命令。',
    related: ['reasoning-effort', 'prompt', 'few-shot', 'hallucination'],
  },
  {
    id: 'guardrails',
    term: 'Guardrails',
    category: 'ai',
    oneLiner_en: 'Rules and checks that keep an AI system inside safe, allowed behavior.',
    oneLiner_zh: '把 AI 系统限制在安全、允许范围内的规则与检查。',
    plainExplain_en:
      'Guardrails are the rails on the road, not the engine: they do not make the car faster, they keep it from leaving the road. For an AI worker that means bounded file access, blocked destructive commands, spending limits, and a rule that nothing ships without tests passing.',
    plainExplain_zh:
      '护栏是路上的栏杆，不是发动机：它不会让车更快，而是防止车冲出路外。对 AI 执行者来说，这意味着受限的文件访问、被禁止的破坏性命令、花费上限，以及“测试不通过就不交付”的规则。',
    proExplain_en:
      'Layered controls including input validation, tool permission scopes, path allowlists, output schema checks, budget caps, and approval gates. VibeBaton enforces guardrails in code rather than in prompts, because a model can be argued out of a prompt but not out of a filesystem sandbox.',
    proExplain_zh:
      '分层控制，包括输入校验、工具权限范围、路径白名单、输出 schema 检查、预算上限和审批门禁。VibeBaton 把护栏落实在代码里而不是提示词里，因为模型可能被说服绕过提示词，却无法绕过文件系统沙箱。',
    related: ['allowed-paths', 'sandbox', 'critical-task', 'mechanical-gate', 'rate-limit'],
  },
  {
    id: 'model-routing',
    term: 'Model Routing',
    category: 'ai',
    oneLiner_en:
      'Choosing which model handles a request, based on task difficulty, cost, and availability.',
    oneLiner_zh: '根据任务难度、成本和可用性，为请求选择模型。',
    plainExplain_en:
      'Not every job needs the strongest, most expensive model. Routing sends a simple rename to a cheap fast model and an architecture review to a stronger one, like a taxi dispatcher matching cars to trips. It can cut cost dramatically while keeping quality where it matters.',
    plainExplain_zh:
      '并非每件事都需要最强、最贵的模型。路由会把简单的改名交给便宜快速的模型，把架构评审交给更强的模型，就像调度员按行程匹配车辆。它能在保证关键环节质量的同时大幅降低成本。',
    proExplain_en:
      'A policy mapping task tier, role, and budget profile to a provider and model, with health and quota checks before dispatch. VibeBaton routes routine tasks to budget models and critical tasks to stronger ones, and falls through a fallback chain when a provider is rate-limited or down.',
    proExplain_zh:
      '把任务层级、角色和预算方案映射到供应方与模型的策略，并在派发前检查健康状态和配额。VibeBaton 将常规任务路由到经济模型、关键任务路由到更强的模型，并在供应方限流或故障时沿回退链降级。',
    related: ['model', 'budget-profile', 'fallback-chain', 'routine-task', 'critical-task'],
  },
  {
    id: 'evals',
    term: 'Evals',
    category: 'ai',
    oneLiner_en:
      'A repeatable set of test cases used to measure how well an AI system performs a task.',
    oneLiner_zh: '一组可重复运行的测试用例，用来衡量 AI 系统完成某项任务的效果。',
    plainExplain_en:
      'You would not trust a new employee after one good day; you would check a sample of their work over time. Evals are that sample for models and prompts: fixed inputs, graded outputs, and a score you can compare across changes. Without them, "the new prompt feels better" is just a feeling.',
    plainExplain_zh:
      '你不会因为新员工表现好了一天就完全信任他，而是会持续抽查他的工作。评测就是针对模型和提示词的抽查：固定输入、给输出打分，得到可跨版本比较的分数。没有它，“新提示词感觉更好”就只是一种感觉。',
    proExplain_en:
      'Benchmarks built from representative tasks with deterministic checks, rubric grading, or human labels, run on every prompt or model change. VibeBaton treats evals as regression tests for its roles: a prompt change must keep the pass rate on the eval set, and failures become new fixtures.',
    proExplain_zh:
      '由代表性任务构成的评测集，使用确定性检查、评分量表或人工标注，在每次提示词或模型变更时运行。VibeBaton 把评测当作各角色的回归测试：改动提示词必须保持评测集通过率，失败案例会被沉淀为新的 fixture。',
    related: ['benchmark', 'regression', 'unit-test', 'test-coverage', 'prompt'],
  },
  {
    id: 'benchmark',
    term: 'Benchmark',
    category: 'ai',
    oneLiner_en: 'A standard, published task set used to compare models against each other.',
    oneLiner_zh: '一套公开的标准任务集，用来横向比较不同模型。',
    plainExplain_en:
      'Benchmarks are the league tables of AI: useful for a first shortlist, misleading if taken as a guarantee. Models can be tuned for a popular benchmark, and a high score on trivia does not prove good judgement on your codebase. Use them to narrow choices, then test on your own work.',
    plainExplain_zh:
      '基准测试就像 AI 的排行榜：用来做初步筛选很有用，当成保证就会误导。模型可能专门针对热门基准调优，知识问答的高分也不能证明它在你的代码库上有好判断。可以用它缩小选择范围，再在自己的任务上实测。',
    proExplain_en:
      'A fixed dataset and metric (MMLU, SWE-bench, HumanEval, and similar) with known contamination and saturation issues. VibeBaton reads public scores only as a prior for model selection; acceptance still depends on project-level evals and on real tasks passing their verification commands.',
    proExplain_zh:
      '固定的数据集与指标（如 MMLU、SWE-bench、HumanEval 等），并存在已知的数据污染和饱和问题。VibeBaton 只把公开分数当作选择模型的先验；是否采纳仍取决于项目级评测以及真实任务能否通过各自的验证命令。',
    related: ['evals', 'model', 'model-routing', 'test-coverage'],
  },
  {
    id: 'knowledge-cutoff',
    term: 'Knowledge Cutoff',
    category: 'ai',
    oneLiner_en:
      'The date after which a model has no training data and therefore cannot know recent events.',
    oneLiner_zh: '模型训练数据截止的日期，此后发生的事情它无从知晓。',
    plainExplain_en:
      'A model is like a graduate whose textbooks stop at a certain year: excellent on older material, unaware of anything newer unless you show it. A library released after the cutoff may simply not exist for the model, which is where retrieval and up-to-date docs help.',
    plainExplain_zh:
      '模型就像一位教材停在某一年的毕业生：对旧材料很熟，但除非你拿给它看，否则对更新的事物一无所知。截止日期之后发布的库，对它来说可能根本不存在，这正是检索和最新文档能帮上忙的地方。',
    proExplain_en:
      'The end of the training corpus, often reported as a month and year and sometimes fuzzy in practice. VibeBaton does not rely on model memory for APIs: it puts dependency versions, project conventions, and current file contents into the prompt and verifies behavior by running the build.',
    proExplain_zh:
      '训练语料的截止时间，通常以年月表示，实际中有时并不精确。VibeBaton 不依赖模型对 API 的记忆：它把依赖版本、项目约定和当前文件内容放进提示词，并通过运行构建来验证行为。',
    related: ['rag', 'hallucination', 'embedding', 'model'],
  },
  {
    id: 'multimodal',
    term: 'Multimodal',
    category: 'ai',
    oneLiner_en:
      'A model that can take more than one kind of input, such as text plus images or audio.',
    oneLiner_zh: '能接受多种输入形式（例如文字加图片或音频）的模型。',
    plainExplain_en:
      'A text-only model reads; a multimodal one can also look at a screenshot or a diagram. That helps when the problem is visual, like a broken layout, but it does not automatically make the model better at reasoning about code.',
    plainExplain_zh:
      '纯文本模型只会读，多模态模型还能看截图或示意图。当问题出在视觉层面时，比如布局错乱，这很有帮助；但它并不会自动让模型更擅长推理代码。',
    proExplain_en:
      'An architecture that encodes images, audio, or video into the same token stream as text so one model conditions on several modalities. VibeBaton can attach screenshots from a failing browser test to a reviewer prompt, while keeping the mechanical gate and diff review based on text artifacts.',
    proExplain_zh:
      '一种把图像、音频或视频编码进与文本相同的 token 流的架构，使单个模型能同时利用多种模态。VibeBaton 可以把失败的浏览器测试截图附加到评审提示词中，同时保持机械门禁和 diff 评审基于文本产物。',
    related: ['llm', 'model', 'context-window', 'structured-output'],
  },
  {
    id: 'vibe-coding',
    term: 'Vibe Coding',
    category: 'ai',
    oneLiner_en:
      'Building software by describing what you want and letting an AI write the code, iterating from the result.',
    oneLiner_zh: '用自然语言描述想要的东西、让 AI 写代码，再根据结果不断迭代的开发方式。',
    plainExplain_en:
      'Instead of typing every line, you steer: describe the outcome, run the app, and say what to change. It is fast for prototypes and everyday features, but it still needs reading the diff and running the tests, otherwise errors accumulate faster than you can notice them.',
    plainExplain_zh:
      '你不必逐行敲代码，而是负责掌舵：描述目标、运行程序、指出要改的地方。做原型和日常功能时它很快，但仍然需要阅读 diff、运行测试，否则错误会以你来不及察觉的速度累积。',
    proExplain_en:
      'A workflow where the human supplies intent and feedback while the model produces most of the code, a term popularized in early 2025. VibeBaton is built for it: the RFC captures intent, executors do the typing, and the mechanical gate plus independent review keep speed from turning into unverified code.',
    proExplain_zh:
      '一种由人提供意图和反馈、由模型产出大部分代码的工作方式，这一说法在 2025 年初流行开来。VibeBaton 正为此而建：RFC 固定意图，执行者负责敲代码，机械门禁和独立评审则防止速度变成未经检验的代码。',
    related: ['coding-agent', 'rfc', 'mechanical-gate', 'ai-review', 'guided-mode'],
  },
  {
    id: 'human-in-the-loop',
    term: 'Human in the Loop',
    category: 'ai',
    oneLiner_en:
      'A workflow where a person reviews or approves key AI decisions before they take effect.',
    oneLiner_zh: '由人在关键 AI 决策生效前进行审阅或批准的工作流程。',
    plainExplain_en:
      'Autonomy is a spectrum. A human in the loop is a checkpoint where the system pauses and asks before merging a risky change, spending over budget, or running something irreversible. It costs time, so good systems reserve it for the decisions that actually need a person.',
    plainExplain_zh:
      '自主程度是一个连续谱。人在回路就是系统暂停下来征求意见的检查点，例如合并高风险改动、超预算花费或执行不可逆操作之前。它会消耗时间，所以好的系统只把它用在真正需要人来决定的环节。',
    proExplain_en:
      'An approval gate in an otherwise automated pipeline, triggered by risk tier or policy. VibeBaton sends critical tasks and final-gate merges to the waiting-human state, presents the diff and gate evidence, and resumes only after an explicit sign-off from the operator.',
    proExplain_zh:
      '在整体自动化的流程中，由风险层级或策略触发的审批门禁。VibeBaton 会把关键任务和终审门禁合并送入等待人工状态，展示 diff 与门禁证据，只有在操作者明确签核后才继续。',
    related: ['final-gate', 'sign-off', 'waiting-human', 'critical-task', 'mechanical-gate'],
  },
  {
    id: 'headless-mode',
    term: 'Headless Mode',
    category: 'ai',
    oneLiner_en:
      'Running an AI tool without its interactive interface, driven by commands or a scheduler.',
    oneLiner_zh: '不打开交互界面，而由命令或调度器驱动 AI 工具运行的方式。',
    plainExplain_en:
      'A headless browser has no window but still loads pages; a headless AI run has no chat box but still does the work. It is how an agent can run overnight or inside CI: input comes from a prompt and configuration, output goes to logs and files.',
    plainExplain_zh:
      '无头浏览器没有窗口，但照样加载网页；无头 AI 运行没有聊天框，但照样完成任务。智能体能整夜运行或嵌入 CI 就靠这种方式：输入来自提示词和配置，输出写入日志和文件。',
    proExplain_en:
      'A non-interactive execution mode, typically CLI flags plus structured input and output, with no terminal session or human prompts. VibeBaton uses headless runs for daemon and overnight execution, and requires an explicit policy for any step that would otherwise wait for a human.',
    proExplain_zh:
      '一种非交互执行模式，通常由 CLI 参数加上结构化输入输出构成，没有终端会话，也不会弹出人工提示。VibeBaton 用无头运行支持守护进程和夜间执行，并对任何原本需要等待人工的步骤要求显式策略。',
    related: ['daemon', 'overnight-run', 'cli', 'waiting-human', 'cli-driver'],
  },
];
