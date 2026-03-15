-- ToastTV Logo Overlay Script
-- Reads pre-computed raw BGRA overlay from /tmp/toasttv-logo.json
-- Node.js (MpvClient.updateLogo) does the heavy lifting once:
--   ffprobe → dimensions, ffmpeg → raw BGRA conversion with opacity baked in
-- This script just reads the config and calls overlay-add.
-- Zero subprocesses during playback transitions.

local utils = require("mp.utils")

local overlay_id = 1
local logo_visible = false
local CONFIG_PATH = "/tmp/toasttv-logo.json"

-- Calculate pixel position from corner position code + margins
-- Position codes (match settings grid):
--   0 = Top-Left, 2 = Top-Right, 6 = Bottom-Left, 8 = Bottom-Right
local function calc_position(cfg, osd_w, osd_h)
    local pos = cfg.position or 2  -- default: top-right
    local mx = cfg.marginX or 10
    local my = cfg.marginY or 10
    local w = cfg.width
    local h = cfg.height

    local x, y

    -- Horizontal: left or right
    if pos == 0 or pos == 6 then
        x = mx                       -- Left
    else
        x = osd_w - w - mx           -- Right (default)
    end

    -- Vertical: top or bottom
    if pos == 6 or pos == 8 then
        y = osd_h - h - my           -- Bottom
    else
        y = my                        -- Top (default)
    end

    return x, y
end

-- Read the pre-computed logo config from disk and apply overlay
local function apply_logo()
    local f = io.open(CONFIG_PATH, "r")
    if not f then return end
    local json_str = f:read("*all")
    f:close()

    local cfg = utils.parse_json(json_str)
    if not cfg or not cfg.rawPath then return end

    -- Verify raw file exists
    local raw = io.open(cfg.rawPath, "r")
    if not raw then
        mp.msg.warn("Logo raw file not found: " .. cfg.rawPath)
        return
    end
    raw:close()

    -- Get OSD dimensions
    local osd_w, osd_h = mp.get_osd_size()
    if not osd_w or osd_w == 0 then
        osd_w = 1920
        osd_h = 1080
    end

    -- Calculate position based on corner setting
    local pos_x, pos_y = calc_position(cfg, osd_w, osd_h)

    -- Apply overlay directly from pre-computed raw BGRA — no subprocess needed
    -- fmt=0 means BGRA with premultiplied alpha
    mp.commandv("overlay-add", overlay_id, pos_x, pos_y, cfg.rawPath,
                0, 0, cfg.width, cfg.height, cfg.width * 4)

    logo_visible = true
    mp.msg.info("Logo overlay applied at " .. pos_x .. "," .. pos_y ..
                " (" .. cfg.width .. "x" .. cfg.height .. ") pos=" .. (cfg.position or 2))
end

local function hide_overlay()
    if logo_visible then
        mp.commandv("overlay-remove", overlay_id)
        logo_visible = false
        mp.msg.info("Logo overlay removed")
    end
end

-- Re-apply overlay on file change (MPV clears overlays between tracks)
mp.register_event("file-loaded", function()
    mp.add_timeout(0.1, function()
        apply_logo()
        -- Clear info text when playing (not idle)
        if not mp.get_property_bool("idle-active") then
            clear_info()
        end
    end)
end)

-- Settings changed — Node.js sends this after writing new config JSON
mp.register_script_message("reload-logo", function()
    apply_logo()
end)

-- Legacy handler for backward compatibility
mp.register_script_message("show-logo", function()
    apply_logo()
end)

mp.register_script_message("hide-logo", function()
    hide_overlay()
end)

-- Display info text (IP/status) from /tmp/toasttv-info
local function draw_info()
    local f = io.open("/tmp/toasttv-info", "r")
    if not f then return end

    local lines = {}
    for line in f:lines() do
        table.insert(lines, line)
    end
    f:close()

    if #lines == 0 then return end

    local osd_w, osd_h = mp.get_osd_size()
    if not osd_w or osd_w == 0 then
        osd_w = 1920
        osd_h = 1080
    end

    -- ASS formatting
    local ass = ""
    ass = ass .. string.format("{\\an7\\pos(%d,%d)\\fs48\\bord2\\3c&H000000&\\c&HFFFFFF&}", 20, osd_h - 100)

    for _, line in ipairs(lines) do
        ass = ass .. line .. "\\N"
    end

    mp.set_osd_ass(osd_w, osd_h, ass)
end

function clear_info()
    local osd_w, osd_h = mp.get_osd_size()
    if not osd_w then osd_w = 1920; osd_h = 1080 end
    mp.set_osd_ass(osd_w, osd_h, "")
end

-- Observe idle property to toggle info text AND default logo
mp.observe_property("idle-active", "bool", function(name, idle)
    if idle then
        draw_info()
        apply_logo()
    else
        clear_info()
    end
end)

-- Initial draw (Startup)
mp.add_timeout(1.0, function()
    local is_idle = mp.get_property_bool("idle-active")
    if is_idle then
        draw_info()
        apply_logo()
    end
end)
