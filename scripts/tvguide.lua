-- ToastTV TV Guide Overlay Script
-- Renders a retro-branded "Now/Next" info banner on screen.
-- Triggered via IPC: script-message show-guide <json>
-- Uses mp.set_osd_ass() for rendering (proven compatible with Pi).

local utils = require("mp.utils")

-- Overlay state
local hide_timer = nil
local guide_visible = false

-- ToastTV brand colors (in OSD markup &HBBGGRR& format)
local COLOR_YELLOW = "\\1c&H00C8FF&"     -- toast-yellow (#FFC800)
local COLOR_PINK   = "\\1c&H9696FF&"     -- toast-pink   (#FF9696)
local COLOR_TEAL   = "\\1c&HFFCC64&"     -- toast-teal   (#64CCFF)
local COLOR_GREEN  = "\\1c&H64C864&"     -- toast-green   (#64C864)
local COLOR_BLUE   = "\\1c&HFF9632&"     -- toast-blue   (#3296FF)
local COLOR_WHITE  = "\\1c&HFFFFFF&"
local COLOR_BLACK  = "\\1c&H000000&"
local COLOR_BG     = "\\1c&H1E1E1E&"     -- dark bg

local BORDER_BLACK = "\\3c&H000000&"
local SHADOW_DARK  = "\\4c&H000000&"

-- Format seconds to MM:SS
local function fmt_time(seconds)
    if not seconds or seconds < 0 then return "0:00" end
    local m = math.floor(seconds / 60)
    local s = math.floor(seconds % 60)
    return string.format("%d:%02d", m, s)
end

-- Build the guide overlay (matching logo.lua's proven ASS pattern)
local function build_overlay(data, osd_w, osd_h)
    local x = 56
    local y = osd_h - 160

    -- Session text
    local session_text = ""
    if data.sessionMinutes >= 0 then
        session_text = tostring(data.sessionMinutes) .. " min left"
    end

    -- Now title
    local now_title = data.now or "—"
    if #now_title > 32 then
        now_title = now_title:sub(1, 29) .. "..."
    end

    -- Next title
    local next_text = "—"
    local next_time = ""
    if data.next then
        next_text = data.next
        if #next_text > 32 then
            next_text = next_text:sub(1, 29) .. "..."
        end
        next_time = fmt_time(data.nextDuration)
    end

    -- Build ASS string — ToastTV vibrant brand colors
    -- Warm dark background with brand accent colors
    local ass = string.format(
        "{\\an7\\pos(%d,%d)\\bord18\\3c&H1A1010&\\c&HFFFFFF&}",
        x, y
    )

    -- Session time (toast-yellow / orange)
    if session_text ~= "" then
        ass = ass .. "{\\c&H00C8FF&\\fs22\\b1}" .. session_text .. "\\N"
        ass = ass .. "{\\c&H00C8FF&\\fs10}* * * * * * * * * * * * * *\\N"
    end

    -- NOW (toast-teal label, white title)
    ass = ass .. "{\\c&HFFCC64&\\fs20\\b1}NOW   {\\c&HFFFFFF&\\fs28\\b1}" .. now_title
    ass = ass .. "{\\fs16\\c&HDDDDDD&\\b0}   " .. fmt_time(data.nowPosition) .. "/" .. fmt_time(data.nowDuration) .. "\\N"

    -- NEXT (toast-pink label, white title)
    ass = ass .. "{\\c&H9696FF&\\fs18\\b1}NEXT  {\\c&HFFFFFF&\\fs24\\b0}" .. next_text
    if next_time ~= "" then
        ass = ass .. "{\\fs16\\c&HDDDDDD&}   " .. next_time
    end
    ass = ass .. "\\N"

    -- Off-Air notice
    if data.isOffAir then
        ass = ass .. "{\\fs6}\\N"
        ass = ass .. "{\\c&HBBBBBB&\\fs14}Limit resumes at " .. tostring(data.resetHour) .. ":00\\N"
    end

    return ass
end

local function show_guide(json_str)
    if not json_str or json_str == "" then return end

    -- Toggle: if visible, hide immediately
    if guide_visible then
        hide_guide()
        return
    end

    -- Parse JSON
    local data = utils.parse_json(json_str)
    if not data then return end

    -- Get OSD dimensions
    local osd_w, osd_h = mp.get_osd_size()
    if not osd_w or osd_w == 0 then
        osd_w = 1280
        osd_h = 800
    end

    -- Build and display
    local markup = build_overlay(data, osd_w, osd_h)
    mp.set_osd_ass(osd_w, osd_h, markup)
    guide_visible = true

    -- Cancel existing timer if any
    if hide_timer then
        hide_timer:kill()
    end

    -- Auto-hide after 5 seconds
    hide_timer = mp.add_timeout(5.0, function()
        hide_guide()
    end)
end

function hide_guide()
    mp.set_osd_ass(0, 0, "")
    if hide_timer then
        hide_timer:kill()
        hide_timer = nil
    end
    guide_visible = false
end

-- Register IPC messages
mp.register_script_message("show-guide", show_guide)
mp.register_script_message("hide-guide", hide_guide)
