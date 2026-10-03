# Miki Web UI — বাকি Optimization কাজের Prompt

তুমি Agent Miki। Phase 1, Phase 2 এবং Phase 3 ইতিমধ্যে সম্পন্ন হয়েছে। এখন বাকি কাজগুলো নিজে সিদ্ধান্ত নিয়ে সম্পূর্ণ করো। আমাকে কীভাবে করতে হবে তা ব্যাখ্যা করবে না; সাধারণ মানুষের মতো সংক্ষিপ্ত status দেবে এবং কাজ করে ফলাফল দেখাবে। কোনো feature ভেঙে গেলে আগে সমস্যাটি চিহ্নিত করবে, তারপর নিজেই ঠিক করবে।

## ইতিমধ্যে সম্পন্ন

- Baseline audit সম্পন্ন।
- Gateway deep-link refresh 404 সমস্যা সমাধান হয়েছে।
- Frontend lint ও Prettier clean হয়েছে।
- Frontend tests: ১৮টি file, ১২৪টি test passed।
- Hashed frontend assets-এর immutable cache যুক্ত হয়েছে।
- Initial HTML থেকে অপ্রয়োজনীয় `vendor-highlight` preload সরানো হয়েছে।
- 24/7 supervisor চালু আছে।

## বাকি কাজের ধাপ

### ধাপ ১ — Responsive UI audit

Desktop, tablet এবং mobile viewport-এ নিচের pageগুলো পরীক্ষা করো:

- Chat
- Plugins overview
- Providers
- Channels
- Capabilities
- Core Services
- Models
- Agents
- Automations
- Health
- Logs
- Configuration

যেখানে horizontal overflow, কাটা লেখা, অপ্রয়োজনীয় scroll, overlapping card, ছোট tap target বা ভাঙা sidebar পাও, সেগুলো ঠিক করো।

### ধাপ ২ — Mobile navigation ও layout

Mobile view-এ:

- Sidebar সহজে open/close হয় কি না দেখো।
- Page header ও action button visible রাখো।
- Plugin card grid responsive করো।
- Inspector panel screen-এর বাইরে চলে যাচ্ছে কি না দেখো।
- Modal, sheet এবং dropdown viewport-এর মধ্যে রাখো।
- Chat composer keyboard-এর কারণে ঢাকা পড়ছে কি না পরীক্ষা করো।

### ধাপ ৩ — Loading, empty এবং error state

প্রতিটি data-driven page-এ স্পষ্ট state নিশ্চিত করো:

- Loading skeleton
- Empty state
- API error state
- Gateway disconnected state
- Retry action
- Partial data state

একটি shared pattern ব্যবহার করো যাতে প্রতিটি page আলাদা এবং অসঙ্গত loading UI না বানায়।

### ধাপ ৪ — Accessibility

নিচের বিষয়গুলো ঠিক করো:

- Keyboard-only navigation
- Visible focus state
- Logical tab order
- Proper heading hierarchy
- Button ও link-এর accessible name
- Form label ও error message association
- Dialog focus trap
- Escape key behavior
- Screen-reader friendly status text
- Sufficient color contrast
- `prefers-reduced-motion` support

যে accessibility issue পাও, তা test বা deterministic inspection দিয়ে যাচাই করো।

### ধাপ ৫ — Keyboard ও command navigation

Command palette এবং global navigation পরীক্ষা করো:

- Search shortcut কাজ করছে কি না।
- Escape দিয়ে palette বন্ধ হয় কি না।
- Arrow key navigation সঠিক কি না।
- Enter দিয়ে selected item open হয় কি না।
- Browser back/forward-এর সঙ্গে active navigation sync হয় কি না।
- Deep-linked page refresh-এর পর active section ঠিক থাকে কি না।

### ধাপ ৬ — Long-list ও large-content performance

বিশেষ করে Logs, Monitor, Plugins, Skills, Agents এবং Chat page পরীক্ষা করো:

- বড় list render হলে UI freeze হয় কি না।
- Unnecessary re-render আছে কি না।
- Log বা message list-এর জন্য incremental loading বা virtualization দরকার কি না।
- Search/filter করার সময় typing lag হয় কি না।
- Large Markdown বা code block page block করে কি না।

শুধু প্রয়োজনীয় page-এ virtualization যোগ করো; ছোট list-এ অপ্রয়োজনীয় complexity যোগ করো না।

### ধাপ ৭ — Interaction feedback

প্রতিটি action-এর ফল পরিষ্কার করো:

- Save
- Delete
- Install
- Enable/disable
- Connect/disconnect
- Retry
- Copy
- Send message
- Start/stop run

Action চলাকালীন disabled/loading state এবং সফল বা ব্যর্থ হলে toast/status feedback দাও। Double-submit প্রতিরোধ করো।

### ধাপ ৮ — Visual consistency

সব page-এ consistent করো:

- Page header
- Spacing
- Card padding
- Button size
- Input height
- Badge color
- Status indicator
- Empty state
- Error state
- Section divider

বিদ্যমান design system ও shared components পুনঃব্যবহার করো। নতুন duplicate component তৈরি কোরো না যদি shared component ব্যবহার করা যায়।

### ধাপ ৯ — Runtime এবং API resilience

Network failure simulate করে পরীক্ষা করো:

- Gateway unavailable
- Slow API response
- 401/403 response
- 404 response
- 500 response
- WebSocket disconnect/reconnect
- Duplicate request
- Stale query data

User যেন পরিষ্কারভাবে বুঝতে পারে কী হয়েছে এবং retry বা recovery action পায়। Secret বা API key UI-তে প্রকাশ কোরো না।

### ধাপ ১০ — Final quality validation

কোড পরিবর্তনের পর terminal-এ চালাও:

```bash
npm --prefix packages/ui/frontend run lint
npm --prefix packages/ui/frontend run format
npm --prefix packages/ui/frontend run test -- --run
npm --prefix packages/ui/frontend run build
npm run build --workspace=@miki/gateway
```

কোনো failure হলে কারণ খুঁজে ঠিক করো। Warning থাকলে warning-এর কারণ যাচাই করো; অন্ধভাবে warning hide কোরো না।

### ধাপ ১১ — Web UI validation

Terminal test-এর পর অবশ্যই live Web UI-তে পরীক্ষা করো:

- Root chat page
- Plugins overview
- Providers
- Channels
- Capabilities
- Core Services
- Models
- Agents
- Automations
- Health
- Logs
- Mobile viewport

প্রতিটি page direct URL দিয়ে open এবং refresh করো। Browser console error, broken request, visual overflow এবং unusable interaction থাকলে ঠিক করো।

### ধাপ ১২ — Final delivery

শেষে:

- Phase 4 ও Phase 5-এর report লিখো।
- কী কী পরিবর্তন হয়েছে তা সংক্ষেপে লিখো।
- সব test result লিখো।
- Live Web UI health verify করো।
- Route manifest valid কি না পরীক্ষা করো।
- Secret, `.env`, runtime data এবং node_modules বাদ দিয়ে `/home/ubuntu/miki.zip` তৈরি করো।
- ZIP integrity test করো।
- আমাকে report এবং ZIP link দাও।

## গ্রহণযোগ্যতার শর্ত

কাজ সম্পূর্ণ বলা যাবে শুধু তখনই যখন:

- Desktop ও mobile layout usable।
- Major page-এ loading, empty এবং error state আছে।
- Keyboard navigation কাজ করে।
- Accessibility-এর প্রধান issue সমাধান হয়েছে।
- Long list ও large content UI block করে না।
- Lint clean।
- Prettier clean।
- Tests pass।
- Frontend ও gateway build pass।
- Direct route refresh কাজ করে।
- Live Web UI-তে সব major route পরীক্ষা করা হয়েছে।
- Updated `miki.zip` secret ছাড়া তৈরি ও verify করা হয়েছে।
