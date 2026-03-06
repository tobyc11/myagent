"""
Browser MCP Server — exposes macOS browser control to Claude Code.

Default: launches Playwright's bundled Chromium (headed). Self-contained, always works.

To use your real Chrome profile instead (with existing logins/cookies):
  1. Quit Chrome if running
  2. open -a "Google Chrome" --args --remote-debugging-port=9222
  3. export BROWSER_CDP_URL=http://localhost:9222

Config (env vars):
  BROWSER_CDP_URL  Connect to an existing Chrome over CDP instead of launching Playwright's Chromium.
"""

import asyncio
import base64
import os
import re
from typing import Optional

from mcp.server.fastmcp import FastMCP, Image
from playwright.async_api import (
    async_playwright,
    Browser,
    BrowserContext,
    Page,
    Playwright,
)

# ---------------------------------------------------------------------------
# Browser state
# ---------------------------------------------------------------------------

_playwright: Optional[Playwright] = None
_browser: Optional[Browser] = None
_context: Optional[BrowserContext] = None
_pages: list[Page] = []
_active_idx: int = 0

MAX_ARIA_CHARS = 20_000

_CONSENT_LABELS = [
    "Accept all", "Accept All", "Accept and continue", "Accept",
    "I agree", "Agree", "Allow all", "Allow cookies",
    "OK", "Got it", "Consent", "Continue",
]


async def _try_dismiss_consent(page: Page) -> None:
    for label in _CONSENT_LABELS:
        try:
            btn = page.get_by_role("button", name=label)
            if await btn.count() > 0:
                await btn.first.click(timeout=1500)
                return
        except Exception:
            continue

async def _get_active_page() -> Page:
    """Return the active page, launching a browser if needed."""
    global _playwright, _browser, _context, _pages, _active_idx

    # Prune closed pages
    _pages = [p for p in _pages if not p.is_closed()]

    if _pages and _active_idx < len(_pages):
        return _pages[_active_idx]

    if _playwright is None:
        _playwright = await async_playwright().start()

    cdp_url = os.environ.get("BROWSER_CDP_URL")
    if cdp_url:
        # Connect to an existing Chrome instance (e.g. launched with --remote-debugging-port=9222)
        _browser = await _playwright.chromium.connect_over_cdp(cdp_url)
        contexts = _browser.contexts
        _context = contexts[0] if contexts else await _browser.new_context()
        existing = _context.pages
        _pages = existing if existing else [await _context.new_page()]
    else:
        # Default: launch Playwright's bundled Chromium (headed, always works)
        _browser = await _playwright.chromium.launch(
            headless=False,
            args=["--no-first-run", "--no-default-browser-check"],
        )
        _context = await _browser.new_context()
        _pages = [await _context.new_page()]

    _active_idx = 0
    return _pages[0]


def _make_locator(page: Page, target: str):
    """
    Resolve a human-readable target string to a Playwright locator.

    Formats accepted (in priority order):
      role=button[name="Submit"]   ARIA role + accessible name
      label=Email                  Form element by its <label>
      placeholder=Search           Input by placeholder text
      text=Click here              Exact visible text
      css=#my-id                   Raw CSS (escape hatch)
      Submit                       Falls back to get_by_text (partial)
    """
    if target.startswith("role="):
        # e.g. "role=button[name='Submit']"
        rest = target[5:]
        if "[name=" in rest:
            role, name_part = rest.split("[name=", 1)
            name = name_part.rstrip("]").strip("'\"")
            return page.get_by_role(role.strip(), name=name)  # type: ignore[arg-type]
        return page.get_by_role(rest.strip())  # type: ignore[arg-type]
    if target.startswith("label="):
        return page.get_by_label(target[6:])
    if target.startswith("placeholder="):
        return page.get_by_placeholder(target[12:])
    if target.startswith("text="):
        return page.get_by_text(target[5:], exact=True)
    if target.startswith("css=") or target.startswith("#") or target.startswith("."):
        return page.locator(target.removeprefix("css="))
    # ARIA snapshot format: "word "text"" → get_by_role
    m = re.match(r'^(\w+)\s+"(.+)"$', target)
    if m:
        return page.get_by_role(m.group(1), name=m.group(2))  # type: ignore[arg-type]
    # Default: partial text match
    return page.get_by_text(target)


# ---------------------------------------------------------------------------
# MCP server
# ---------------------------------------------------------------------------

mcp = FastMCP("browser")


# --- Observation -------------------------------------------------------


@mcp.tool()
async def observe(include_screenshot: bool = True, selector: str = "body") -> list:
    """
    Primary perception tool. Call this before acting and again after each action
    to verify the result.

    Args:
      include_screenshot: set False to skip the screenshot and only get the ARIA tree.
      selector: CSS selector to scope the ARIA snapshot (default "body").
                Use "main", "article", "#content" to get a smaller tree when the
                full page ARIA tree is too large.

    Returns:
      - Current URL and title
      - ARIA accessibility tree: shows every interactive element as [role] "name".
        Use these names directly in click() and fill() — e.g. [button] "Submit"
        means click("role=button[name='Submit']") or simply click("Submit").
      - Screenshot of the current viewport (set include_screenshot=False when you
        only need the ARIA tree and want to skip the image for speed).
    """
    try:
        page = await _get_active_page()
        title = await page.title()
        url = page.url
        aria_text = await page.locator(selector).aria_snapshot()
        if len(aria_text) > MAX_ARIA_CHARS:
            aria_text = aria_text[:MAX_ARIA_CHARS] + "\n…[ARIA tree truncated — use observe(selector=...) to scope]"
        header = f"URL: {url}\nTitle: {title}\n\nAccessibility tree:\n{aria_text}"

        result = [{"type": "text", "text": header}]

        if include_screenshot:
            png = await page.screenshot()
            result.append({
                "type": "image",
                "data": base64.b64encode(png).decode(),
                "mimeType": "image/png",
            })

        return result

    except Exception as e:
        return [{"type": "text", "text": f"Error: {e}"}]


# --- Navigation --------------------------------------------------------


@mcp.tool()
async def navigate(url: str) -> str:
    """Navigate the active tab to a URL. Waits for the page to load. Returns title and top headings so you often don't need a follow-up observe()."""
    try:
        page = await _get_active_page()
        response = await page.goto(url, wait_until="domcontentloaded", timeout=30000)
        status = response.status if response else "?"
        title = await page.title()
        headings = await page.evaluate(
            "Array.from(document.querySelectorAll('h1,h2')).slice(0,5)"
            ".map(h=>h.innerText.trim()).filter(Boolean)"
        )
        summary = f"Navigated to {page.url} (HTTP {status})\nTitle: {title}"
        if headings:
            summary += "\nTop headings: " + " | ".join(headings)
        try:
            await _try_dismiss_consent(page)
        except Exception:
            pass
        return summary
    except Exception as e:
        return f"Error: {e}"


@mcp.tool()
async def go_back() -> str:
    """Navigate back in browser history. Returns title and top headings."""
    try:
        page = await _get_active_page()
        await page.go_back(wait_until="domcontentloaded")
        title = await page.title()
        headings = await page.evaluate(
            "Array.from(document.querySelectorAll('h1,h2')).slice(0,5)"
            ".map(h=>h.innerText.trim()).filter(Boolean)"
        )
        summary = f"Went back to {page.url}\nTitle: {title}"
        if headings:
            summary += "\nTop headings: " + " | ".join(headings)
        try:
            await _try_dismiss_consent(page)
        except Exception:
            pass
        return summary
    except Exception as e:
        return f"Error: {e}"


@mcp.tool()
async def go_forward() -> str:
    """Navigate forward in browser history. Returns title and top headings."""
    try:
        page = await _get_active_page()
        await page.go_forward(wait_until="domcontentloaded")
        title = await page.title()
        headings = await page.evaluate(
            "Array.from(document.querySelectorAll('h1,h2')).slice(0,5)"
            ".map(h=>h.innerText.trim()).filter(Boolean)"
        )
        summary = f"Went forward to {page.url}\nTitle: {title}"
        if headings:
            summary += "\nTop headings: " + " | ".join(headings)
        try:
            await _try_dismiss_consent(page)
        except Exception:
            pass
        return summary
    except Exception as e:
        return f"Error: {e}"


# --- Tab management ----------------------------------------------------


@mcp.tool()
async def list_tabs() -> str:
    """List all open tabs with their index, URL, and title."""
    try:
        page = await _get_active_page()  # ensures _pages is populated
        lines = []
        for i, p in enumerate(_pages):
            if p.is_closed():
                continue
            marker = " *" if i == _active_idx else ""
            title = await p.title()
            lines.append(f"[{i}]{marker} {p.url}  —  {title}")
        return "\n".join(lines) if lines else "No open tabs"
    except Exception as e:
        return f"Error: {e}"


@mcp.tool()
async def new_tab(url: str = "about:blank") -> str:
    """Open a new browser tab, optionally navigating to a URL. Returns title and top headings."""
    global _pages, _active_idx
    try:
        await _get_active_page()  # ensures _context is set
        page = await _context.new_page()  # type: ignore[union-attr]
        _pages.append(page)
        _active_idx = len(_pages) - 1
        if url != "about:blank":
            await page.goto(url, wait_until="domcontentloaded")
            title = await page.title()
            headings = await page.evaluate(
                "Array.from(document.querySelectorAll('h1,h2')).slice(0,5)"
                ".map(h=>h.innerText.trim()).filter(Boolean)"
            )
            summary = f"Opened tab [{_active_idx}]: {page.url}\nTitle: {title}"
            if headings:
                summary += "\nTop headings: " + " | ".join(headings)
            try:
                await _try_dismiss_consent(page)
            except Exception:
                pass
            return summary
        return f"Opened tab [{_active_idx}]: {page.url}"
    except Exception as e:
        return f"Error: {e}"


@mcp.tool()
async def switch_tab(index: int) -> str:
    """Switch to a tab by its index (from list_tabs)."""
    global _active_idx
    _pages_open = [p for p in _pages if not p.is_closed()]
    if index < 0 or index >= len(_pages_open):
        return f"No tab at index {index}. Use list_tabs to see open tabs."
    _active_idx = index
    page = _pages_open[index]
    title = await page.title()
    return f"Switched to tab [{index}]: {page.url}  —  {title}"


@mcp.tool()
async def close_tab() -> str:
    """Close the active tab and switch to the previous one."""
    global _active_idx
    try:
        page = await _get_active_page()
        await page.close()
        _pages[:] = [p for p in _pages if not p.is_closed()]
        _active_idx = max(0, len(_pages) - 1)
        if _pages:
            title = await _pages[_active_idx].title()
            return f"Tab closed. Now on tab [{_active_idx}]: {title}"
        return "Tab closed. No more tabs open."
    except Exception as e:
        return f"Error: {e}"


# --- Interaction -------------------------------------------------------


@mcp.tool()
async def click(target: str) -> str:
    """
    Click an element identified by a semantic target string.

    Prefer formats in this order (most to least robust):
      "role=button[name='Login']"  — ARIA role + name (use names from observe() output)
      "label=Email address"        — form element by its visible label
      "text=Sign in"               — exact visible text
      "Submit"                     — partial text match (least specific, use as fallback)
      "css=#submit-btn"            — CSS selector (last resort escape hatch)

    Tip: observe() shows elements as [role] "name" — map these directly to
    role=<role>[name='<name>'] for the most reliable targeting.

    Call observe() after clicking to verify the action had the expected effect.
    """
    try:
        page = await _get_active_page()
        locator = _make_locator(page, target)
        await locator.first.click(timeout=10000)
        return f"Clicked: {target}"
    except Exception as e:
        return f"Error clicking '{target}': {e}"


@mcp.tool()
async def fill(target: str, text: str) -> str:
    """
    Clear and fill a text input or textarea with the given text.

    Args:
      target: identifies the input element. Prefer label= or placeholder= for inputs:
                "label=Email address"   — input associated with a <label>
                "placeholder=Search…"   — input by its placeholder text
                "role=textbox[name='Query']" — ARIA role from observe() output
                "css=input[name='q']"   — CSS selector (last resort)
      text:   the string to type into the field (replaces any existing content)

    Call observe() after to confirm the value was accepted (e.g. autocomplete
    suggestions appeared, or validation passed).
    """
    try:
        page = await _get_active_page()
        locator = _make_locator(page, target)
        await locator.first.fill(text, timeout=10000)
        return f"Filled '{target}' with text"
    except Exception as e:
        return f"Error filling '{target}': {e}"


@mcp.tool()
async def press_key(key: str, target: Optional[str] = None) -> str:
    """
    Press a keyboard key, optionally focusing an element first.

    Args:
      key:    key name or chord, e.g. Enter, Tab, Escape, ArrowDown,
              Control+a, Meta+r, Shift+Tab
      target: if provided, focuses this element before pressing the key.
              Use the same target format as click().
              Example: press_key("Enter", target="placeholder=Search…") submits
              a search box. press_key("Escape") dismisses a modal globally.

    Call observe() after if the keypress triggers navigation or a UI change.
    """
    try:
        page = await _get_active_page()
        if target:
            locator = _make_locator(page, target)
            await locator.first.focus(timeout=5000)
        await page.keyboard.press(key)
        return f"Pressed {key}"
    except Exception as e:
        return f"Error pressing '{key}': {e}"


@mcp.tool()
async def scroll(direction: str = "down", amount: int = 500) -> str:
    """
    Scroll the page by a number of pixels.

    Args:
      direction: up | down | left | right
      amount:    pixels to scroll (default 500)

    Use when observe() shows partial content or elements you need are off-screen.
    Call observe() after scrolling to see newly revealed content.
    """
    try:
        page = await _get_active_page()
        dx = {"left": -amount, "right": amount}.get(direction, 0)
        dy = {"down": amount, "up": -amount}.get(direction, 0)
        await page.mouse.wheel(dx, dy)
        return f"Scrolled {direction} {amount}px"
    except Exception as e:
        return f"Error scrolling: {e}"


@mcp.tool()
async def select_option(target: str, value: str) -> str:
    """
    Select an option from a <select> dropdown element.

    Args:
      target: identifies the <select> element — same format as click().
              Prefer "label=Country" or "role=combobox[name='Country']".
      value:  the option to select. Tried in this order:
                1. Exact match on the option's visible label (display text)
                2. Exact match on the option's HTML value attribute
              When in doubt use the visible label text shown in the dropdown.

    Call observe() after to confirm the selection was applied.
    """
    try:
        page = await _get_active_page()
        locator = _make_locator(page, target)
        await locator.first.select_option(value, timeout=10000)
        return f"Selected '{value}' in '{target}'"
    except Exception as e:
        return f"Error selecting: {e}"


# --- Escape hatch ------------------------------------------------------


@mcp.tool()
async def run_js(code: str) -> str:
    """
    Evaluate a JavaScript expression in the page context and return the result as a string.

    Args:
      code: a JS expression (not a statement). Must return a value.
            Examples:
              "document.title"
              "document.querySelector('meta[name=description]').content"
              "window.scrollY"

    Use when:
      - Semantic tools (click, fill) fail and you need to inspect the raw DOM
      - You need to extract data not visible in the ARIA tree (e.g. hidden attributes)
      - You need to trigger a JS event directly

    Avoid using this to navigate or click — prefer navigate(), click() instead.
    """
    try:
        page = await _get_active_page()
        result = await page.evaluate(code)
        return str(result)
    except Exception as e:
        return f"Error: {e}"


# --- Lifecycle ---------------------------------------------------------


@mcp.tool()
async def close_browser() -> str:
    """Close all tabs and the browser. Call when you are done."""
    global _playwright, _browser, _context, _pages, _active_idx
    try:
        if _browser:
            await _browser.close()
        if _playwright:
            await _playwright.stop()
    except Exception:
        pass
    _playwright = _browser = _context = None
    _pages = []
    _active_idx = 0
    return "Browser closed"


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main():
    mcp.run()


if __name__ == "__main__":
    main()
