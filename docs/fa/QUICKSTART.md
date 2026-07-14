<p align="center">
  <b>فارسی</b> &nbsp;·&nbsp; <a href="../GETTING-STARTED.md">English</a>
</p>

<p align="center"><a href="README.md">فهرست راهنمای فارسی</a></p>

# راه‌اندازی سریع چینوات در ویندوز

پیش‌نیازها: Node.js 20 یا جدیدتر و Git.

```powershell
git clone https://github.com/adun-denton/Chinvat.git
cd Chinvat
npm install
npm run build
npm start
```

سپس `http://localhost:7777` را باز کنید.

## افزودن اولین مدل

در صفحهٔ **Modules** یکی را انتخاب کنید:

- `ollama`: اجرای محلی؛ مدل را با `ollama pull qwen3` دریافت کنید.
- `openrouter`: مدل‌های میزبانی‌شده؛ `API key` را وارد کنید.
- `openai-compatible`: یک ماژول عمومی برای NVIDIA، Groq، Together، LM Studio و vLLM. این نام‌ها ماژول‌های جداگانه نیستند. فیلدهای آن `Base URL`، `API key`، `Default model` و `Custom headers (JSON)` هستند.

ماژول را Enable و Save کنید و **Test connection** را بزنید. کلید NVIDIA را در OpenRouter قرار ندهید؛ آن را مستقیماً در `openai-compatible` وارد کنید.

## اتصال هماهنگ‌کننده

در صفحهٔ **Connect** برنامه را انتخاب، Preview را بررسی و سپس Install را اجرا کنید. Endpoint محلی:

```text
http://127.0.0.1:7777/mcp
```

HTTP برای Codex، Claude Code، Cursor، Hermes و Generic پیش‌فرض است. Claude Desktop از HTTP بومی پشتیبانی نمی‌کند؛ از `node hub/dist/index.js --stdio` یا `npx mcp-remote` استفاده کنید و `url` خام را در تنظیمات آن قرار ندهید.

پس از Reload یا Restart لازم، بنویسید:

```text
Use Chinvat to list available workers and capabilities.
```

برای اولین Job:

```text
Use Chinvat's Ollama worker to summarize this text: ...
```

## Policy

- `observe`: عملیات `read` اجرا می‌شوند؛ `act` و `dangerous` رد می‌شوند.
- `approve`: عملیات `read` اجرا می‌شوند؛ `act` و `dangerous` با وضعیت `waiting_approval` متوقف می‌شوند.
- `autonomous`: همهٔ عملیات اجرا و ثبت می‌شوند.

Inference مدل‌ها `read` است و در هیچ Tier منتظر Approval نمی‌ماند. برای شروع، ماژول‌های System، Messaging و Publishing را روی `approve` نگه دارید.

## WordPress پیشرفته (اختیاری)

ماژول `wordpress` بدون Plugin اضافی، Post، Page، Media، Taxonomy و Block Navigation را از Core REST مدیریت می‌کند؛ `get_page` و `update_page` محتوای Page موجود را می‌خوانند و ویرایش می‌کنند، `list_navigation`/`get_navigation`/`update_navigation` رکوردهای `wp_navigation` را مدیریت می‌کنند، Media دارای List/Get/Metadata Update/Delete است، `featured_media` در Create/Update پذیرفته می‌شود و `upload_media` فایل را از URL عمومی محدودشده یا Base64 دریافت می‌کند. Publish/Delete و تغییر Navigation زنده از نوع `dangerous` هستند. برای Options، فایل‌های Active theme، DB-layer مربوط به Global Styles و Site Editor templates، RankMath، مدیریت Plugin و ساخت Child theme سازگار با Block، [Chinvat WP Bridge](../../wp-plugin/chinvat-bridge/README.md) نسخهٔ `0.4.2` را نصب کنید. ماژول TypeScript نسخهٔ `0.3.1` نوزده Operation ثابت `bridge_*` را اجرا می‌کند؛ پیش از Styling از `bridge_db_state` استفاده کنید تا مشخص شود DB override یا فایل Theme در Runtime حاکم است. DB writeها به **Developer Mode** و **DB Layer (Global Styles & Templates)** نیاز دارند.

## ابزارهای MCP

هفت ابزار دقیقاً عبارت‌اند از: `workers_list`، `capabilities_describe`، `tasks_submit`، `tasks_status`، `tasks_result`، `tasks_cancel` و `adapter_invoke`.

برای Job پایدار از `tasks_submit { module, operation, args, mode:"sync"|"async", parent_id?, wait_ms? }` و برای فراخوانی Sync سریع از `adapter_invoke { module, operation, args }` استفاده کنید.
