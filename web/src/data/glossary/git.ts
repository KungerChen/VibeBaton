import type { GlossaryEntry } from './types';

export const GIT_TERMS: GlossaryEntry[] = [
  {
    id: 'repository',
    term: 'Repository',
    aliases: ['version history', '版本记录'],
    category: 'git',
    oneLiner_en: 'A project folder whose complete change history is tracked by Git.',
    oneLiner_zh: '一个由 Git 记录完整修改历史的项目文件夹。',
    plainExplain_en:
      'Picture a folder with a built-in time machine: every saved version of every file is kept, so you can see who changed what and return to any earlier point. VibeBaton needs your project to be a repository so it can work safely and undo anything.',
    plainExplain_zh:
      '可以想象成一个自带时光机的文件夹：每个文件的每个保存版本都会被留下，你能看到谁改了什么，也能回到任意一个过去的时间点。VibeBaton 需要你的项目是一个仓库，这样才能安全地工作，并且随时可以撤销。',
    proExplain_en:
      'A working tree plus a `.git` directory holding the object database (commits, trees, blobs) and refs. VibeBaton requires a repository with at least one commit on the base branch; it creates task branches and worktrees inside it and never rewrites history you made.',
    proExplain_zh:
      '由工作区和 `.git` 目录组成，后者保存对象数据库（commit、tree、blob）与各类引用。VibeBaton 要求仓库的基础分支上至少有一次提交；它会在仓库内创建任务分支和 worktree，但绝不改写你已有的历史。',
    related: ['commit', 'branch', 'worktree', 'working-tree', 'clone'],
  },
  {
    id: 'commit',
    term: 'Commit',
    category: 'git',
    oneLiner_en: 'A saved snapshot of the project with a short message explaining the change.',
    oneLiner_zh: '项目的一次存档快照，附带一句说明本次修改的话。',
    plainExplain_en:
      'Like pressing save in a game: the commit captures the exact state of every file at that moment, and you can always load it again later. Small, well-described commits make it easy to see what each AI worker did.',
    plainExplain_zh:
      '就像游戏里的存档：一次提交会记下那一刻所有文件的准确状态，以后随时可以读档回来。提交越小、说明越清楚，就越容易看出每个 AI 执行者做了什么。',
    proExplain_en:
      'An immutable object identified by a SHA hash that points to a tree snapshot, its parent commit(s), the author, and a message. Each passing VibeBaton task lands as a commit on its task branch and merges into its milestone branch before reaching the dev branch, keeping every change reviewable and revertible.',
    proExplain_zh:
      '一个由 SHA 哈希标识的不可变对象，指向一份目录树快照、父提交、作者和提交说明。VibeBaton 中每个通过的任务都会先在自己的任务分支上形成提交，经过验收后合并进所属里程碑分支，最后汇入 dev 分支，因此每处改动都可以审阅和回退。',
    related: ['commit-message', 'commit-hash', 'branch', 'revert', 'diff'],
  },
  {
    id: 'branch',
    term: 'Branch',
    category: 'git',
    oneLiner_en: 'A separate line of development that lets work continue without disturbing the main version.',
    oneLiner_zh: '一条独立的开发路线，让工作在不打扰主版本的情况下继续推进。',
    plainExplain_en:
      'Think of parallel drafts of the same document: each draft can be edited on its own, and the shared original stays untouched until you choose to combine them. VibeBaton gives every task its own branch so parallel workers never edit the same timeline.',
    plainExplain_zh:
      '可以想象同一份文件的多个平行草稿：每份都能独立修改，共享的原稿在你决定合并之前保持不变。VibeBaton 为每个任务准备独立分支，让并行的执行者不会改到同一条时间线。',
    proExplain_en:
      'A movable pointer to a commit, stored under `refs/heads/`; new commits move only that branch forward while other branches keep their own tips. VibeBaton creates a task branch for each work unit, runs verification there, and squash-merges it into its milestone branch only after the gates pass.',
    proExplain_zh:
      '指向某个提交的可移动指针，存放在 `refs/heads/` 下；新提交只让当前分支前移，其他分支保持各自的末端。VibeBaton 为每个工作单元创建任务分支，在其中运行验证，只有通过门禁后才压缩合并进所属的里程碑分支。',
    related: ['main-branch', 'merge', 'checkout', 'commit', 'worktree'],
  },
  {
    id: 'merge',
    term: 'Merge',
    category: 'git',
    oneLiner_en: 'The operation that joins the history of one branch into another.',
    oneLiner_zh: '把一个分支的历史接入另一个分支的操作。',
    plainExplain_en:
      'It is like taking two edited copies of a shared report and combining them into one final version; overlapping edits may need a person to decide what stays. VibeBaton merges a task branch only after its checks pass, so the dev branch receives reviewed work.',
    plainExplain_zh:
      '就像把两份分别修改过的共享报告合成一份定稿；如果改动落在同一处，就需要人来决定保留什么。VibeBaton 只在任务分支通过检查后才执行合并，因此开发分支收到的是已经审阅过的成果。',
    proExplain_en:
      'A merge joins two or more commit histories. Git fast-forwards when the target tip is already an ancestor; otherwise it creates a merge commit with multiple parents, and overlapping hunks become conflicts. VibeBaton squash-merges task branches and ties the resulting commit message to the task id.',
    proExplain_zh:
      '合并会把两条或多条提交历史连接起来。当目标末端已经是来源末端的祖先时，Git 会快进；否则会创建带有多个父提交的合并提交，重叠的改动块则变成冲突。VibeBaton 以压缩合并的方式整合任务分支，并让生成的提交信息与任务 id 对应。',
    related: ['branch', 'fast-forward', 'conflict', 'commit', 'rebase'],
  },
  {
    id: 'rebase',
    term: 'Rebase',
    category: 'git',
    oneLiner_en: 'Replaying your commits on top of another branch so the history appears as one straight line.',
    oneLiner_zh: '把你的提交重新应用到另一个分支之上，让历史看起来是一条直线。',
    plainExplain_en:
      'Imagine restaging every scene of a play on a newer stage: the scenes are the same, but their positions and scene numbers change. Rebasing keeps history tidy, yet it gives every moved snapshot a brand-new ID, so it is best reserved for private branches nobody else has copied yet.',
    plainExplain_zh:
      '可以想象把一出戏的每一幕搬到更新的舞台上重演：内容没变，但位置和场次编号变了。变基能让历史更整洁，不过每次移动后的存档都会换上全新的编号，所以最好只用于还没有分享给别人的分支。',
    proExplain_en:
      'Rebase takes the commits unique to your branch and reapplies their patches onto a new base, creating new commit objects with new hashes; it can also edit, reorder, squash, or drop commits interactively. VibeBaton avoids rebasing shared branches and prefers merge-based integration so the audit trail stays truthful.',
    proExplain_zh:
      '变基会找出当前分支独有的提交，把它们的补丁重新应用到新的基底上，生成新的提交对象和新哈希；交互式变基还能编辑、重排、压缩或丢弃提交。VibeBaton 不对共享分支做变基，而倾向于基于合并的整合方式，以保持审计记录真实可信。',
    related: ['merge', 'commit', 'commit-hash', 'squash', 'conflict'],
  },
  {
    id: 'worktree',
    term: 'Worktree',
    category: 'git',
    oneLiner_en: 'A working directory attached to the same repository as another, with its own checked-out branch.',
    oneLiner_zh: '附加在同一仓库上的额外工作目录，拥有自己检出的分支。',
    plainExplain_en:
      'Picture opening the same project at a second desk in another room: your tools and current page are separate, but both desks draw from one filing cabinet. VibeBaton gives each task its own worktree so parallel workers cannot overwrite files belonging to one another.',
    plainExplain_zh:
      '可以想象在另一个房间的第二张桌子上打开同一个项目：工具和当前页面各自独立，但两张桌子共用同一个文件柜。VibeBaton 为每个任务分配独立工作树，并行的执行者就不会互相覆盖文件。',
    proExplain_en:
      '`git worktree add` creates a linked working tree with its own HEAD and index that shares the object database and refs; Git refuses to check out the same branch in two worktrees. VibeBaton creates one worktree per task under `.baton/worktrees`, runs gates inside it, and removes it after merge or abandonment.',
    proExplain_zh:
      '`git worktree add` 会创建一个关联工作树，它拥有自己的 HEAD 和索引，但共享对象数据库与引用；Git 不允许同一分支同时检出到两个工作树。VibeBaton 在 `.baton/worktrees` 下为每个任务创建工作树，在其中运行门禁，并在合并或放弃后删除。',
    related: ['repository', 'branch', 'head', 'checkout', 'working-tree'],
  },
  {
    id: 'tag',
    term: 'Tag',
    matchCase: true,
    category: 'git',
    oneLiner_en: 'A fixed name attached to one commit, usually to mark a release or a known-good point.',
    oneLiner_zh: '固定在某个提交上的名称，通常用来标记发布版本或已知可用的时间点。',
    plainExplain_en:
      'A tag is like a sticker placed on one page of a book: it stays on that page even as new pages are written. That makes it easy to say version 1.0 was exactly this code and return to it later.',
    plainExplain_zh:
      '标签就像贴在书某一页上的标记：即使后面继续写新页，它也始终留在那一页。因此你可以准确地说「1.0 版就是这段代码」，并在以后回到那个状态。',
    proExplain_en:
      'A ref under `refs/tags/`, either lightweight (just a commit pointer) or annotated (a tag object with message, tagger, and optional signature). Unlike a branch, a tag does not advance. VibeBaton creates lightweight `baton-backup/<run_id>` tags so there is always a named snapshot of where the run started.',
    proExplain_zh:
      '位于 `refs/tags/` 下的引用，可以是轻量标签（仅指向提交），也可以是附注标签（包含说明、打标签者及可选签名）。标签不会像分支那样前移。VibeBaton 会创建轻量标签 `baton-backup/<run_id>`，因此运行的起始位置始终有一个具名快照。',
    related: ['commit', 'branch', 'commit-hash', 'main-branch', 'remote'],
  },
  {
    id: 'stash',
    term: 'Stash',
    category: 'git',
    oneLiner_en: 'A temporary shelf for uncommitted changes so you can switch tasks with a clean working tree.',
    oneLiner_zh: '临时存放未提交改动的架子，让你能带着干净的工作区切换任务。',
    plainExplain_en:
      'When an urgent request interrupts you, a stash sweeps the half-finished pages into a drawer and clears the desk; later you can take them out. It is convenient, but easy to forget, so anything worth keeping should become a commit instead.',
    plainExplain_zh:
      '当有急事打断你时，贮藏会把做到一半的页面收进抽屉并清空桌面，稍后还能再取出来。它很方便，但也容易被遗忘；真正值得保留的内容应该提交，而不是长期放在贮藏里。',
    proExplain_en:
      '`git stash` records the working tree and index as commit objects under `refs/stash` and resets those files to HEAD; `pop` reapplies and drops the entry, while `apply` keeps it. VibeBaton prefers real commits because they are visible on a branch and survive cleanup.',
    proExplain_zh:
      '`git stash` 会把工作区和索引保存为 `refs/stash` 下的提交对象，并把相关文件恢复到 HEAD 状态；`pop` 会重新应用并删除记录，`apply` 则保留记录。VibeBaton 更偏好真实提交，因为提交在分支上可见，也不会在清理中丢失。',
    related: ['working-tree', 'staging-area', 'commit', 'checkout', 'head'],
  },
  {
    id: 'diff',
    term: 'Diff',
    category: 'git',
    oneLiner_en: 'A line-by-line comparison showing exactly what changed between two versions of files.',
    oneLiner_zh: '逐行比较两个文件版本，准确显示改动内容的差异。',
    plainExplain_en:
      'It is the track-changes view for code: added lines and removed lines sit side by side so a reviewer can see every edit. Reading the diff is the fastest way to check what an AI worker actually changed.',
    plainExplain_zh:
      '它相当于代码的「修订模式」：新增行和删除行并列呈现，审阅者能看清每一处改动。阅读差异是检查 AI 执行者究竟改了什么的最快方式。',
    proExplain_en:
      'A diff computes differences between blobs, trees, commits, the index, or the working tree, usually rendered in unified format with `@@` hunk headers and `+`/`-` lines. VibeBaton feeds the task diff to the AI reviewer and uses changed paths to enforce the allowed-paths whitelist.',
    proExplain_zh:
      '差异会比较 blob、目录树、提交、索引或工作区之间的内容，通常以 unified 格式呈现，包含 `@@` 区块头和 `+`/`-` 行。VibeBaton 把任务差异交给 AI 评审，并用变更路径来执行允许路径白名单。',
    related: ['commit', 'working-tree', 'staging-area', 'conflict', 'blame'],
  },
  {
    id: 'conflict',
    term: 'Conflict',
    category: 'git',
    oneLiner_en: 'A state where two changes touch the same lines and Git cannot decide which version to keep.',
    oneLiner_zh: '两处改动涉及同一批代码行，Git 无法决定保留哪个版本的状态。',
    plainExplain_en:
      'Imagine two editors rewriting the same sentence of a shared draft at once; a person has to open both versions and choose the final wording. VibeBaton stops instead of guessing, and hands the conflicted files back with both sides visible.',
    plainExplain_zh:
      '想象两位编辑同时改写共享草稿里的同一句话：必须有人打开两个版本，决定最终的措辞。VibeBaton 不会猜测，而是停下来，把双方内容都保留在冲突文件里交回处理。',
    proExplain_en:
      'Merge, rebase, and cherry-pick stop with unmerged index entries and conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) when hunks overlap. Resolving means editing the file, staging it with `git add`, and continuing or aborting the operation. VibeBaton treats remaining conflict markers as a failure and records a conflicting merge as waiting for a human decision.',
    proExplain_zh:
      '当改动块重叠时，合并、变基和拣选会停下，索引中留下未合并条目，文件中出现冲突标记（`<<<<<<<`、`=======`、`>>>>>>>`）。解决方式是编辑文件、用 `git add` 暂存，然后继续或中止操作。VibeBaton 会把残留的冲突标记视为失败，并把冲突合并记录为等待人工决策的状态。',
    related: ['merge', 'rebase', 'diff', 'working-tree', 'merge-conflict'],
  },
  {
    id: 'clone',
    term: 'Clone',
    category: 'git',
    oneLiner_en: 'A complete local copy of a remote repository, including all of its history.',
    oneLiner_zh: '远程仓库在本机的完整副本，包含全部历史。',
    plainExplain_en:
      'Cloning is like receiving the entire library, not just the books currently on display: you get every past edition and can work offline. VibeBaton operates on your local clone, so experiments stay on your machine until you choose to push.',
    plainExplain_zh:
      '克隆就像收到整座图书馆，而不只是当前展出的书：你会得到所有历史版本，也可以离线工作。VibeBaton 在本地克隆上操作，因此实验都留在你的机器上，直到你选择推送。',
    proExplain_en:
      '`git clone <url>` creates a new repository, downloads the remote objects and refs, configures the source as `origin`, and checks out the default branch. A clone is independent after that point; updates arrive only through fetch or pull. VibeBaton expects a local clone and never edits the remote directly.',
    proExplain_zh:
      '`git clone <url>` 会新建仓库、下载远程对象与引用、把来源配置为 `origin`，并检出默认分支。此后克隆是独立的，只有获取或拉取才会带来更新。VibeBaton 以本地克隆为工作对象，绝不直接修改远程仓库。',
    related: ['repository', 'remote', 'origin', 'fetch', 'fork'],
  },
  {
    id: 'remote',
    term: 'Remote',
    category: 'git',
    oneLiner_en: 'A named copy of the repository hosted elsewhere, such as on a team server.',
    oneLiner_zh: '托管在其他位置（例如团队服务器）的仓库副本的名称。',
    plainExplain_en:
      'Think of a shared filing cabinet in another building: you keep your own copy at your desk and exchange folders when needed. A remote is a nickname plus a URL, not a live connection that updates by itself.',
    plainExplain_zh:
      '可以把它想成另一栋楼里的共享文件柜：你在自己的桌上保留副本，需要时交换文件夹。远程仓库只是一个名称加一个 URL，并不是会自动同步的实时连接。',
    proExplain_en:
      'A named URL with fetch and push refspecs in `.git/config`; `origin` is the conventional first one. Remotes are synchronization endpoints, and local branches do not change until you fetch, pull, or push. VibeBaton works on the local repository and does not modify remotes; publishing a branch is a separate step you control.',
    proExplain_zh:
      '它是在 `.git/config` 中配置的名称，带有获取与推送的 refspec；`origin` 是约定的默认名称。远程仓库是同步端点，只有执行获取、拉取或推送后本地分支才会变化。VibeBaton 在本地仓库上工作，不会修改远程仓库；是否发布分支由你单独决定。',
    related: ['origin', 'clone', 'fetch', 'push', 'pull'],
  },
  {
    id: 'push',
    term: 'Push',
    matchCase: true,
    category: 'git',
    oneLiner_en: 'Sending your local commits to a remote repository so others can see them.',
    oneLiner_zh: '把本地提交发送到远程仓库，让其他人可以看到。',
    plainExplain_en:
      'It is like uploading your finished pages to the shared folder: the pages now exist in both places, and teammates can pull them. If someone else changed the same branch first, Git rejects the push rather than silently overwriting their work.',
    plainExplain_zh:
      '就像把完成的页面上传到共享文件夹：两边都有了这些页面，队友可以拉取。如果别人先改动了同一分支，Git 会拒绝推送，而不是悄悄覆盖对方的成果。',
    proExplain_en:
      'Push updates remote refs from local refs and transfers the missing objects; it is rejected when the update is not a fast-forward unless force is used. Force-pushing rewrites shared history and is never appropriate on a protected branch. VibeBaton keeps remote operations outside its task loop, so a push is always a deliberate step after the gates have passed.',
    proExplain_zh:
      '推送会用本地引用更新远程引用，并传输缺失的对象；如果更新不是快进，除非强制推送，否则会被拒绝。强制推送会改写共享历史，在受保护分支上绝不合适。VibeBaton 把远程操作留在任务循环之外，因此推送始终是门禁通过后由你主动执行的一步。',
    related: ['remote', 'pull', 'fetch', 'upstream', 'branch'],
  },
  {
    id: 'pull',
    term: 'Pull',
    matchCase: true,
    category: 'git',
    oneLiner_en: 'Fetching remote changes and integrating them into your current branch.',
    oneLiner_zh: '获取远程改动并整合进当前分支。',
    plainExplain_en:
      'Pull is a two-step errand: first collect the latest shared pages, then merge them into your draft. It can finish as a simple fast-forward or create a merge when both sides moved, so commit your own work first.',
    plainExplain_zh:
      '拉取包含两步：先取回最新的共享页面，再把它们并入你的草稿。如果双方都有新改动，可能是简单快进，也可能产生合并，所以开始前先提交自己的修改。',
    proExplain_en:
      '`git pull` is `git fetch` followed by `git merge` (or `git rebase` when configured), acting on the current branch and its upstream. VibeBaton integrates task branches locally with squash merges, so a pull is not part of its normal task flow.',
    proExplain_zh:
      '`git pull` 相当于先 `git fetch`，再对当前分支及其上游执行 `git merge`（配置为变基时则执行 `git rebase`）。VibeBaton 在本地以压缩合并整合任务分支，因此拉取不属于它的常规任务流程。',
    related: ['fetch', 'merge', 'rebase', 'remote', 'upstream'],
  },
  {
    id: 'fetch',
    term: 'Fetch',
    category: 'git',
    oneLiner_en: 'Downloading new commits and refs from a remote without changing your own branch.',
    oneLiner_zh: '从远程下载新的提交和引用，但不改动你自己的分支。',
    plainExplain_en:
      'Fetch restocks the library shelf without touching the page you are writing. You can inspect what arrived and decide whether to merge it, which is safer than pulling blindly.',
    plainExplain_zh:
      '获取会把书架的库存补齐，但不会动你正在写的页面。你可以先看看取回了什么，再决定是否合并，这比不加检查地拉取更稳妥。',
    proExplain_en:
      'Fetch updates remote-tracking refs such as `refs/remotes/origin/main` and downloads the objects they reference, but leaves local branches and the working tree alone. VibeBaton plans and integrates from the local repository, so fetching first is your responsibility when a remote has newer work.',
    proExplain_zh:
      '获取会更新 `refs/remotes/origin/main` 这类远程跟踪引用并下载相应对象，但不会改动本地分支和工作区。VibeBaton 基于本地仓库进行规划和整合，因此当远程有更新时，先获取是你的责任。',
    related: ['remote', 'pull', 'origin', 'upstream', 'branch'],
  },
  {
    id: 'origin',
    term: 'Origin',
    category: 'git',
    oneLiner_en: 'The default name Git gives to the remote a repository was cloned from.',
    oneLiner_zh: 'Git 为克隆来源的远程仓库默认指定的名称。',
    plainExplain_en:
      'Origin is the return address on a package, not a special server: it is just the nickname Git chose for the URL you cloned from. You can rename it or add other remotes without changing any history.',
    plainExplain_zh:
      '`origin` 就像包裹上的寄件地址，并不是特殊的服务器：它只是 Git 为你克隆时使用的 URL 起的昵称。你可以重命名它或添加其他远程仓库，而不会影响任何历史。',
    proExplain_en:
      'An ordinary remote alias, conventionally set to the clone URL with refspecs such as `+refs/heads/*:refs/remotes/origin/*`. Nothing in Git requires the name; `upstream` is common for the original repository of a fork. VibeBaton does not depend on the name `origin`; it works with the local repository however the remotes are named.',
    proExplain_zh:
      '它是一个普通的远程别名，通常指向克隆 URL，并带有 `+refs/heads/*:refs/remotes/origin/*` 之类的 refspec。Git 并不要求必须叫这个名字；在派生仓库中，`upstream` 常用来指向原始仓库。VibeBaton 不依赖 `origin` 这个名称；无论远程如何命名，它都只使用本地仓库。',
    related: ['remote', 'clone', 'fetch', 'push', 'upstream'],
  },
  {
    id: 'main-branch',
    term: 'Main Branch',
    category: 'git',
    oneLiner_en: 'The primary branch of a repository, where finished and accepted work is expected to land.',
    oneLiner_zh: '仓库的主分支，完成并通过验收的工作最终应进入这里。',
    plainExplain_en:
      'Treat it as the master copy of the shared document: work happens on drafts, and only reviewed changes return to it. The branch is often named `main`, and older repositories may still call it `master`.',
    plainExplain_zh:
      '可以把它当作共享文档的定稿：工作在草稿上进行，只有经过审阅的改动才会回到这里。这个分支通常叫 `main`，较旧的仓库可能仍称为 `master`。',
    proExplain_en:
      'The default branch that `HEAD` points to after a clone and the usual target of protected-branch rules; its name is a convention, not a Git requirement. VibeBaton calls the configured one the base branch, keeps its own dev branch separate, and merges dev into base only at the final gate.',
    proExplain_zh:
      '它是克隆后 `HEAD` 默认指向的分支，通常也是受保护分支规则的目标；其名称只是约定，并非 Git 的硬性要求。VibeBaton 把配置的主分支称为基础分支，单独维护开发分支，并且只在终审门禁时才把开发分支合并进基础分支。',
    related: ['branch', 'merge', 'dev-branch', 'head', 'fast-forward'],
  },
  {
    id: 'head',
    term: 'HEAD',
    category: 'git',
    oneLiner_en: 'The reference that points to the commit currently checked out in a working tree.',
    oneLiner_zh: '指向你当前正在查看的那个存档位置的标记。',
    plainExplain_en:
      'HEAD is the you-are-here marker on the project map; it decides which version of the files appears on your desk. When it moves to another branch, the visible files change with it.',
    plainExplain_zh:
      'HEAD 是项目地图上的「你在这里」标记，决定桌面上显示哪个版本的文件。当它移动到另一个分支时，你看到的文件也会随之改变。',
    proExplain_en:
      '`.git/HEAD` normally contains `ref: refs/heads/<branch>`, making it a symbolic pointer to the current branch tip; it contains a raw commit id when detached. Expressions such as `HEAD~1` and `HEAD^` navigate from it. VibeBaton records the resolved HEAD commit as the base for each task.',
    proExplain_zh:
      '`.git/HEAD` 通常包含 `ref: refs/heads/<branch>`，因此它是指向当前分支末端的符号引用；处于分离状态时则直接包含提交 ID。`HEAD~1`、`HEAD^` 等写法从它出发进行导航。VibeBaton 会记录解析后的 HEAD 提交，作为每个任务的基线。',
    related: ['detached-head', 'branch', 'commit', 'checkout', 'worktree'],
  },
  {
    id: 'detached-head',
    term: 'Detached HEAD',
    category: 'git',
    oneLiner_en: 'A state where HEAD points directly to a commit instead of to a branch.',
    oneLiner_zh: 'HEAD 直接指向某个提交，而不是指向分支的状态。',
    plainExplain_en:
      'It is like reading a particular page without placing a bookmark: you can look around and even write notes, but if you leave, those notes have no named place to return to. Create a branch before committing if the work matters.',
    plainExplain_zh:
      '就像翻到某一页阅读却没有插书签：你可以查看甚至写笔记，但离开后这些笔记没有具名的位置可以找回。如果这些工作重要，请在提交前先创建分支。',
    proExplain_en:
      'Checking out a commit, tag, or remote-tracking branch detaches HEAD; new commits are then reachable only through reflog or a new branch. VibeBaton treats a detached HEAD as an unsafe starting point and asks for a real branch before running tasks.',
    proExplain_zh:
      '检出某个提交、标签或远程跟踪分支会使 HEAD 进入分离状态；此后新提交只能通过 reflog 或新建分支找回。VibeBaton 把分离 HEAD 视为不安全的起点，会在运行任务前要求切换到真实分支。',
    related: ['head', 'branch', 'checkout', 'commit', 'detached-head-error'],
  },
  {
    id: 'staging-area',
    term: 'Staging Area',
    category: 'git',
    oneLiner_en: 'The holding area where you prepare exactly what the next commit will contain.',
    oneLiner_zh: '为下一次提交准备内容的中转区，决定哪些改动会被记录。',
    plainExplain_en:
      'Think of a packing table: you choose items from the room and place them in the box before sealing it. The staging area lets you include only part of your edits in a commit, keeping each commit focused.',
    plainExplain_zh:
      '可以想象一张打包桌：你从房间里挑选物品放进箱子，然后再封箱。暂存区让你只把部分改动放进一次提交，从而让每个提交保持聚焦。',
    proExplain_en:
      'The index, usually `.git/index`, stores blob ids, modes, and paths for the next tree; `git add` updates it, and `git commit` snapshots it. The index can also hold unresolved conflict stages. VibeBaton stages task changes before committing them with a message tied to the task id.',
    proExplain_zh:
      '索引通常位于 `.git/index`，为下一棵目录树保存 blob ID、文件模式和路径；`git add` 更新索引，`git commit` 对其做快照。索引还可能保存未解决的冲突阶段。VibeBaton 会先暂存任务改动，再用与任务 id 关联的信息提交。',
    related: ['working-tree', 'commit', 'diff', 'checkout', 'reset'],
  },
  {
    id: 'working-tree',
    term: 'Working Tree',
    category: 'git',
    oneLiner_en: 'The files you can see and edit on disk, checked out from a commit.',
    oneLiner_zh: '磁盘上可见、可编辑的文件，由某个提交检出而来。',
    plainExplain_en:
      'The working tree is your desk: it holds the pages currently open, and it can differ from the last saved snapshot until you commit. A clean working tree means nothing on the desk is unsaved.',
    plainExplain_zh:
      '工作区就是你的桌面：上面放着当前打开的页面，在你提交之前，它可以和上一次存档不同。工作区干净，意味着桌面上没有未保存的内容。',
    proExplain_en:
      'The checked-out files, together with the index, are compared with HEAD to produce status and diffs; untracked files exist only here until added. VibeBaton refuses a rollback while uncommitted changes are present outside `.baton/`, which is the dirty-working-tree condition.',
    proExplain_zh:
      '检出的文件连同索引一起与 HEAD 比较，从而产生状态和差异；未跟踪文件在加入索引前只存在于工作区。当 `.baton/` 之外存在未提交改动时，VibeBaton 会拒绝回退，这就是 dirty-working-tree 所描述的情况。',
    related: ['repository', 'staging-area', 'commit', 'checkout', 'dirty-working-tree'],
  },
  {
    id: 'gitignore',
    term: '.gitignore',
    category: 'git',
    oneLiner_en: 'A file listing paths that Git should not track or commit.',
    oneLiner_zh: '一份清单文件，列出 Git 不应跟踪或提交的路径。',
    plainExplain_en:
      'It works like a do-not-pack list for the project: build output, downloaded packages, local settings, and secrets stay out of the shared history. That keeps commits small and prevents private values from being published.',
    plainExplain_zh:
      '它相当于项目的「不要打包」清单：构建产物、下载的依赖、本地设置和密钥都不会进入共享历史。这让提交保持精简，也避免私密信息被发布出去。',
    proExplain_en:
      'Patterns in a `.gitignore` apply to untracked files in that directory and below, following glob rules, negation with `!`, and directory-only suffixes; tracked files are not affected. Global and per-repository excludes can add more rules. VibeBaton keeps its `.baton/` state and tool caches out of commits, and expects build output and secrets to be ignored as well.',
    proExplain_zh:
      '`.gitignore` 中的模式作用于该目录及其子目录里的未跟踪文件，遵循 glob 规则、`!` 取反以及仅匹配目录的后缀写法；已跟踪文件不受影响。全局和仓库级排除文件可以追加规则。VibeBaton 会把 `.baton/` 状态和工具缓存排除在提交之外，同时期望构建产物与密钥也已被忽略。',
    related: ['repository', 'working-tree', 'commit', 'staging-area', 'allowed-paths'],
  },
  {
    id: 'commit-message',
    term: 'Commit Message',
    category: 'git',
    oneLiner_en: 'The text attached to a commit that explains what changed and why.',
    oneLiner_zh: '附加在提交上、说明改了什么以及为什么改的文字。',
    plainExplain_en:
      'A commit message is the note you leave for the next reader, who may be a teammate or an AI agent months later. A short summary on the first line and the reason below make the history far easier to navigate than a pile of vague labels.',
    plainExplain_zh:
      '提交信息是留给下一位读者的便条，对方可能是几个月后的队友，也可能是 AI 执行者。第一行写简短摘要，下面补充原因，会比一堆含糊的标签更容易理解历史。',
    proExplain_en:
      'Git stores the message verbatim in the commit object. Conventions favor an imperative subject under about 72 characters, a blank line, then a body and trailers such as `Co-authored-by` or `Refs`. VibeBaton prefixes the worker commit with `baton(<task-id>):` and the squash merge with `feat(<task-id>):`, so every change can be traced back to its task.',
    proExplain_zh:
      'Git 会把提交信息原样存入提交对象。常见规范是使用祈使语气的标题、控制在约 72 个字符以内，空一行后写正文，并可使用 `Co-authored-by`、`Refs` 等尾注。VibeBaton 会为执行者的提交加上 `baton(<task-id>):` 前缀，为压缩合并提交加上 `feat(<task-id>):` 前缀，使每处改动都能追溯到对应任务。',
    related: ['commit', 'commit-hash', 'log', 'branch', 'diff'],
  },
  {
    id: 'commit-hash',
    term: 'Commit Hash',
    category: 'git',
    oneLiner_en: 'The unique identifier Git computes for a commit from its content and parent history.',
    oneLiner_zh: 'Git 根据提交内容及其父历史计算出的唯一标识。',
    plainExplain_en:
      'A hash is a fingerprint: the same commit content and history always produce the same value, while any change produces a different one. The short form is enough for daily conversation, and the full form removes ambiguity.',
    plainExplain_zh:
      '哈希就像指纹：相同的提交内容和历史总是产生相同的值，任何改动都会得到不同的值。日常交流用缩写就够了，需要消除歧义时再使用完整值。',
    proExplain_en:
      'Git hashes a header plus the commit body (tree, parents, author, committer, message), producing a SHA-1 id by default and SHA-256 in repositories created with that object format. Abbreviated hashes are unique within a repository. VibeBaton records the merged commit hash at the final gate so a later rollback can confirm that the base branch has not moved.',
    proExplain_zh:
      'Git 会对提交头与提交正文（目录树、父提交、作者、提交者、提交信息）一起做哈希，默认生成 SHA-1 ID，而采用新对象格式的仓库会生成 SHA-256 ID。缩写哈希在单个仓库内保持唯一。VibeBaton 在终审门禁记录合并后的提交哈希，使后续回退能够确认基础分支没有被移动过。',
    related: ['commit', 'commit-message', 'head', 'log', 'revert'],
  },
  {
    id: 'log',
    term: 'Log',
    matchCase: true,
    category: 'git',
    oneLiner_en: 'The ordered record of commits that makes up a repository history.',
    oneLiner_zh: '按顺序记录仓库历史的提交清单。',
    plainExplain_en:
      'The log is the project diary: each entry says what was saved, when, and by whom. Reading it backwards from the newest commit is often the quickest way to understand how the current code came to be.',
    plainExplain_zh:
      '提交日志就是项目日记：每条记录说明在什么时间、由谁保存了什么内容。从最新提交往回读，通常是理解当前代码如何演变的最快方式。',
    proExplain_en:
      '`git log` walks the commit graph reachable from HEAD or a given ref, supporting formats, filters, path limits, and `--graph`. It shows commits, not the content of the working tree. VibeBaton records a commit for each passing task, so the log becomes the audit trail of what a run produced.',
    proExplain_zh:
      '`git log` 会遍历从 HEAD 或指定引用可达的提交图，支持格式化、筛选、路径限制和 `--graph`。它展示的是提交，而不是工作区的内容。VibeBaton 会为每个通过的任务留下提交，因此日志就是一次运行产出的审计轨迹。',
    related: ['commit', 'commit-hash', 'commit-message', 'branch', 'blame'],
  },
  {
    id: 'checkout',
    term: 'Checkout',
    category: 'git',
    oneLiner_en: 'The Git command that switches branches or restores files to a chosen version.',
    oneLiner_zh: '切换分支，或把文件恢复到指定版本的 Git 命令。',
    plainExplain_en:
      'Checkout moves your desk to another chapter of the project, or pulls an older page back onto the desk. The file-restoring form can overwrite unsaved edits, so commit first when those edits matter.',
    plainExplain_zh:
      '检出会把你的桌面切换到项目的另一章，或把旧页面重新取回桌面。用于恢复文件的形式可能覆盖未保存的修改，因此这些修改重要时请先提交。',
    proExplain_en:
      '`git checkout` updates HEAD, the index, and the working tree; with a branch it switches, with a commit it detaches HEAD, and with `-- <path>` it restores files. Because those roles differ sharply, Git added `switch` and `restore` as focused replacements. VibeBaton creates an isolated worktree for each task and restores only paths that violated the whitelist.',
    proExplain_zh:
      '`git checkout` 会更新 HEAD、索引和工作区；跟分支名时切换分支，跟提交时进入分离 HEAD，使用 `-- <path>` 时恢复文件。由于这些职责差异很大，Git 后来新增了更专注的 `switch` 与 `restore`。VibeBaton 为每个任务创建隔离工作树，并且只恢复违反白名单的路径。',
    related: ['switch', 'branch', 'detached-head', 'working-tree', 'head'],
  },
  {
    id: 'switch',
    term: 'Switch',
    matchCase: true,
    category: 'git',
    oneLiner_en: 'The focused Git command for moving to a different branch.',
    oneLiner_zh: '专门用于切换到另一个分支的 Git 命令。',
    plainExplain_en:
      'Switch changes lanes on the same project road: it moves you to another branch and updates the files to match. Git stops the switch when uncommitted edits would be overwritten, giving you a chance to save them first.',
    plainExplain_zh:
      '切换命令就像在同一条项目道路上换车道：它把你带到另一个分支，并同步更新文件。如果有未提交的修改会被覆盖，Git 会阻止切换，让你先保存。',
    proExplain_en:
      '`git switch <branch>` updates HEAD, the index, and the working tree, and `-c` creates a new branch in one step; unlike `checkout`, it cannot restore individual paths. VibeBaton isolates branch movement in per-task worktrees, leaving the main checkout untouched.',
    proExplain_zh:
      '`git switch <branch>` 会更新 HEAD、索引和工作区，`-c` 可以一步创建并切换新分支；与 `checkout` 不同，它不能恢复单个路径。VibeBaton 把分支移动隔离在各任务的工作树中，让主检出保持原样。',
    related: ['checkout', 'branch', 'head', 'working-tree', 'detached-head'],
  },
  {
    id: 'reset',
    term: 'Reset',
    category: 'git',
    oneLiner_en: 'The Git command that rewinds a branch to an earlier snapshot, with an option to keep or discard newer edits.',
    oneLiner_zh: '把当前分支倒回某个旧存档的 Git 命令，可选择保留或丢弃之后的修改。',
    plainExplain_en:
      'Reset is a rewind control: how far you rewind decides whether your later edits stay on the desk or disappear. Because it can rewrite branch history, it is safest on changes that are still only local.',
    plainExplain_zh:
      '重置就像倒带：倒回多远，决定了之后的修改是留在桌面上还是被丢弃。由于它可能改写分支历史，最好只用于尚未共享的本地改动。',
    proExplain_en:
      '`--soft` moves only the branch ref, `--mixed` (the default) also resets the index, and `--hard` resets the working tree too, discarding uncommitted changes. Reset can make commits unreachable, and those commits may later be garbage-collected. VibeBaton uses it for explicit rollback and for cleaning up temporary merge worktrees, not for rewriting shared history.',
    proExplain_zh:
      '`--soft` 只移动分支引用，`--mixed`（默认）还会重置索引，`--hard` 则连工作区一起重置，未提交的改动会丢失。重置可能让提交不可达，这些提交之后可能被垃圾回收。VibeBaton 只在明确的回退和清理临时合并工作树时使用它，不用来改写共享历史。',
    related: ['revert', 'head', 'staging-area', 'working-tree', 'rollback'],
  },
  {
    id: 'revert',
    term: 'Revert',
    category: 'git',
    oneLiner_en: 'Creating a new commit that undoes the changes introduced by an earlier commit.',
    oneLiner_zh: '创建一个新提交，用来抵消之前某次提交引入的改动。',
    plainExplain_en:
      'Revert is a correction note in the diary rather than an eraser: the original entry stays, and a new entry explains what was undone. That makes it the safer choice for work that other people may already have pulled.',
    plainExplain_zh:
      '还原更像在日记里写一条更正，而不是用橡皮擦掉原文：原记录保留，新记录说明撤销了什么。对于别人可能已经拉取过的内容，这是更安全的选择。',
    proExplain_en:
      '`git revert <commit>` applies the inverse diff to the current branch and records a new commit, preserving history; it can conflict and supports `--no-commit` or `--mainline` for merges. VibeBaton rolls a run back by resetting the base branch to the head recorded before the final merge, so the earlier commits remain recoverable instead of being rewritten.',
    proExplain_zh:
      '`git revert <commit>` 会把反向差异应用到当前分支并生成新提交，从而保留历史；它可能产生冲突，也支持 `--no-commit` 或针对合并提交的 `--mainline`。VibeBaton 通过把基础分支重置到最后一次合并前记录的提交来回退一次运行，因此原有提交仍然可以找回，而不是被改写。',
    related: ['reset', 'commit', 'rollback', 'conflict', 'log'],
  },
  {
    id: 'cherry-pick',
    term: 'Cherry-pick',
    category: 'git',
    oneLiner_en: 'Copying the change from a single commit onto the current branch.',
    oneLiner_zh: '把某一个提交的改动复制到当前分支上。',
    plainExplain_en:
      'It is like copying one recipe from another cookbook instead of taking the whole book: you get just that change, and the copy gets its own fingerprint. Use it when a fix belongs here but the entire source branch does not.',
    plainExplain_zh:
      '就像从另一本食谱里只抄一道菜，而不是把整本书搬过来：你只得到那一处改动，而且副本会有自己的指纹。当某个修复需要带过来、但整个来源分支不需要合并时，就可以用它。',
    proExplain_en:
      'Cherry-pick computes a commit diff and applies it to the current HEAD, creating a new commit with a new hash but the original message; conflicts are possible, and `-x` records the source hash. VibeBaton keeps each task on its own branch, so a targeted fix can be cherry-picked without dragging in unrelated work.',
    proExplain_zh:
      '拣选会计算某个提交的差异并应用到当前 HEAD，生成哈希不同但沿用原提交信息的新提交；可能发生冲突，`-x` 会记录来源哈希。VibeBaton 让每个任务保留在独立分支上，因此可以只拣选特定修复，而不会带入无关工作。',
    related: ['commit', 'branch', 'merge', 'rebase', 'commit-hash'],
  },
  {
    id: 'squash',
    term: 'Squash',
    category: 'git',
    oneLiner_en: 'Combining several commits into one commit.',
    oneLiner_zh: '把多个提交合并成一个提交。',
    plainExplain_en:
      'Squash turns a messy stack of draft pages into one clean page that is easier to review. The trade-off is that the individual steps disappear from history, so the task record must still explain how the result was reached.',
    plainExplain_zh:
      '压缩提交会把一叠凌乱的草稿整理成一页干净的定稿，更便于审阅。代价是中间步骤会从历史中消失，因此任务记录仍需说明结果是怎样得到的。',
    proExplain_en:
      'In interactive rebase, `squash` combines a commit with the previous one and offers a combined message; `fixup` discards the later message. A host can also squash-merge a pull request into one commit. VibeBaton squash-merges task branches into the milestone branch so each task lands as one reviewable change.',
    proExplain_zh:
      '在交互式变基中，`squash` 会把提交与前一个合并并让你编辑合并后的信息，`fixup` 则丢弃后一个提交的信息。托管平台也可以把拉取请求压缩成一个提交再合并。VibeBaton 会把任务分支压缩合并进里程碑分支，让每个任务以一个可审阅的改动落地。',
    related: ['merge', 'rebase', 'commit', 'pull-request', 'commit-message'],
  },
  {
    id: 'fast-forward',
    term: 'Fast-forward',
    category: 'git',
    oneLiner_en: 'A merge that moves the branch forward when no divergent work exists.',
    oneLiner_zh: '在没有分叉改动时，直接把分支往前推进到新存档的合并方式。',
    plainExplain_en:
      'If pages were added strictly in order, moving the bookmark forward is enough; no new combined page is needed. This is the simplest merge, and it leaves no merge commit behind.',
    plainExplain_zh:
      '如果页面是严格按顺序追加的，只需把书签往前移，不需要再合成新页。这是最简单的合并方式，也不会留下合并提交。',
    proExplain_en:
      'A fast-forward is possible when the target tip is an ancestor of the source tip, so Git only updates the ref and creates no merge commit; `--no-ff` forces a merge commit instead. VibeBaton does not rely on fast-forwards for task integration; it squash-merges so each task has a distinct integration commit.',
    proExplain_zh:
      '当目标末端是来源末端的祖先时就可以快进，Git 只更新引用，不创建合并提交；使用 `--no-ff` 则会强制生成合并提交。VibeBaton 的任务整合不依赖快进，而是压缩合并，让每个任务都有独立的整合提交。',
    related: ['merge', 'branch', 'commit', 'main-branch', 'rebase'],
  },
  {
    id: 'upstream',
    term: 'Upstream',
    category: 'git',
    oneLiner_en: 'The remote branch that a local branch is configured to track.',
    oneLiner_zh: '本地分支被配置为跟踪的远程分支。',
    plainExplain_en:
      'Think of a paired notebook: your copy and the team copy are linked, so Git knows which remote branch to compare with and where a bare push or pull should go.',
    plainExplain_zh:
      '可以想象一对配套的笔记本：你的副本和团队副本建立了关联，Git 因此知道该和哪个远程分支比较，以及直接执行推送或拉取时该去哪里。',
    proExplain_en:
      'Set through `branch.<name>.remote` and `branch.<name>.merge`, usually with `git push -u` or `git branch --set-upstream-to`; it enables ahead and behind counts. VibeBaton does not require an upstream because its task flow stays local.',
    proExplain_zh:
      '它通过 `branch.<name>.remote` 与 `branch.<name>.merge` 配置，通常用 `git push -u` 或 `git branch --set-upstream-to` 设置；有了它才能统计领先和落后提交数。VibeBaton 不要求配置上游，因为它的任务流程完全在本地进行。',
    related: ['remote', 'origin', 'branch', 'push', 'pull'],
  },
  {
    id: 'pull-request',
    term: 'Pull Request',
    category: 'git',
    oneLiner_en: 'A request to review and merge one branch into another, hosted by a collaboration platform.',
    oneLiner_zh: '在协作平台上请求审阅并把一个分支合并进另一个分支。',
    plainExplain_en:
      'It is the digital equivalent of handing a marked-up draft to a colleague and asking for comments before it joins the shared document. Reviewers can discuss specific lines, request changes, and approve.',
    plainExplain_zh:
      '它相当于把批注过的草稿交给同事，请对方在并入共享文档前提出意见。审阅者可以针对具体代码行讨论、要求修改，最后批准。',
    proExplain_en:
      'A pull request is a platform feature, not a Git primitive: it pairs a source branch with a target branch, tracks discussion and checks, and adds the merge commit when approved. VibeBaton mirrors that flow locally through task branches, mechanical gates, and AI review when configured; a hosted pull request is only needed when you choose to publish the branch.',
    proExplain_zh:
      '拉取请求是平台功能，而不是 Git 原语：它把来源分支与目标分支配对，记录讨论和检查结果，并在批准后添加合并提交。VibeBaton 在本地用任务分支、机械门禁和按需启用的 AI 评审复现这一流程；只有当你选择发布分支时，才需要托管平台的拉取请求。',
    related: ['branch', 'merge', 'code-review', 'remote', 'fork'],
  },
  {
    id: 'fork',
    term: 'Fork',
    matchCase: true,
    category: 'git',
    oneLiner_en: 'A separate copy of another repository that you can change independently.',
    oneLiner_zh: '他人仓库的一份独立副本，你可以自行修改。',
    plainExplain_en:
      'Forking is like photocopying a shared manual so you can annotate your own copy; the original stays untouched, and improvements travel back through a pull request. It is different from a branch, which lives inside the same repository.',
    plainExplain_zh:
      '派生就像复印一本共享手册，方便你在自己的副本上做批注；原书不受影响，改进则通过拉取请求送回。它与分支不同：分支位于同一个仓库内部。',
    proExplain_en:
      'A server-side copy with its own refs, permissions, and issue tracker, typically linked to the original as `upstream`. Forks drift over time and are refreshed by fetching upstream. VibeBaton works on a local clone of either the original or a fork and never modifies the source repository.',
    proExplain_zh:
      '它是服务器端的仓库副本，拥有自己的引用、权限和议题追踪，通常把原始仓库配置为 `upstream`。派生仓库会随时间产生偏差，需要从上游获取更新。VibeBaton 在原始仓库或派生仓库的本地克隆上工作，绝不修改来源仓库。',
    related: ['clone', 'remote', 'upstream', 'pull-request', 'repository'],
  },
  {
    id: 'blame',
    term: 'Blame',
    category: 'git',
    oneLiner_en: 'A view that shows which commit last changed each line of a file.',
    oneLiner_zh: '显示文件每一行最后一次由哪个提交改动的视图。',
    plainExplain_en:
      'Blame adds a margin note to every line naming the commit and author behind it, which helps explain why the code looks the way it does. It is a history tool, not a tool for assigning fault to a person.',
    plainExplain_zh:
      '追溯会为每一行加上边注，标明它来自哪个提交和哪位作者，帮助解释代码为何是现在这个样子。它是历史分析工具，而不是用来把责任归到某个人身上的工具。',
    proExplain_en:
      '`git blame` annotates each line with commit hash, author, and date; options such as `-C` and `-M` help follow code that moved or was copied, and `--ignore-rev` skips noisy formatting commits. VibeBaton preserves the commit history that blame depends on, so a reviewer can trace a suspicious line instead of guessing.',
    proExplain_zh:
      '`git blame` 会为每一行标注提交哈希、作者和日期；`-C`、`-M` 等选项可以追踪被移动或复制的代码，`--ignore-rev` 能跳过纯格式化的干扰提交。VibeBaton 会保留 blame 所依赖的提交历史，让评审者可以追溯可疑行的来源，而不是靠猜测。',
    related: ['log', 'commit', 'commit-hash', 'diff', 'revert'],
  },
  {
    id: 'submodule',
    term: 'Submodule',
    category: 'git',
    oneLiner_en: 'A separate Git repository embedded at a fixed commit inside another repository.',
    oneLiner_zh: '嵌入在另一个仓库中、固定在某个提交上的独立 Git 仓库。',
    plainExplain_en:
      'Think of a bibliography entry that points to an exact edition of another book: the parent records which edition it expects but does not contain the whole book. Updating that edition is a separate, explicit step.',
    plainExplain_zh:
      '可以想象书目里引用另一本书的特定版本：父项目记录它期望哪个版本，但并不包含整本书的内容。更新这个版本是一个独立且明确的步骤。',
    proExplain_en:
      'The parent tree stores a gitlink to a commit, `.gitmodules` stores the URL and path, and the submodule has its own HEAD, often detached. Clones need `--recurse-submodules`, and updates must be committed in the parent. VibeBaton treats submodule paths as boundaries and does not descend into them when checking allowed paths.',
    proExplain_zh:
      '父仓库的目录树保存指向某个提交的 gitlink，`.gitmodules` 保存 URL 与路径，子模块拥有自己的 HEAD，通常处于分离状态。克隆时需要 `--recurse-submodules`，更新后还必须在父仓库中提交新的指向。VibeBaton 把子模块路径视为边界，在检查允许路径时不会深入其中。',
    related: ['repository', 'clone', 'commit', 'worktree', 'gitignore'],
  },
  {
    id: 'hook',
    term: 'Hook',
    matchCase: true,
    category: 'git',
    oneLiner_en: 'A script Git runs automatically at a specific point, such as before a commit is created.',
    oneLiner_zh: 'Git 在特定时机（例如创建提交之前）自动运行的脚本。',
    plainExplain_en:
      'A hook is a checkpoint at the door: every commit or push passes through it, and the script can inspect, modify, or block the action. Hooks are convenient locally but are not copied by a clone, so they cannot be the only line of defense.',
    plainExplain_zh:
      '钩子就像门口的检查点：每次提交或推送都会经过它，脚本可以检查、修改或阻止这次操作。钩子在本地很方便，但克隆时不会被复制，因此不能作为唯一的防线。',
    proExplain_en:
      'Executable files in `.git/hooks` (or the directory set by `core.hooksPath`) named after events such as `pre-commit`, `commit-msg`, `pre-push`, and `post-merge`; they are local, not versioned, and can be skipped with `--no-verify`. VibeBaton runs verification as explicit gate commands outside hooks so results are recorded independently of the local hook setup on each machine.',
    proExplain_zh:
      '它们是 `.git/hooks`（或 `core.hooksPath` 指定的目录）中按事件命名的可执行文件，例如 `pre-commit`、`commit-msg`、`pre-push`、`post-merge`；这些脚本只存在于本地、不受版本控制，也能被 `--no-verify` 跳过。VibeBaton 把验证作为显式的门禁命令在钩子之外运行，因此结果会被记录，不受每台机器本地钩子配置的影响。',
    related: ['commit', 'push', 'staging-area', 'ci', 'mechanical-gate'],
  },
];
