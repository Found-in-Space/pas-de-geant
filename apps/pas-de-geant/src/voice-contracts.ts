import type { VoiceToolContract } from '@found-in-space/voice-os';
const emptyParameters = { type: 'object', properties: {}, additionalProperties: false };
export const EARTH_VOICE_TOOLS = [
    {
        name: "get_navigation_state",
        description: "Read the current placement mode, focus body, universal 1:N scale denominator, and terrain exaggeration.",
        parameters: { type: "object", properties: {}, additionalProperties: false }
    },
    {
        name: "get_journey_state",
        description: "Read the current Earth-to-Gaia preset status, phase, elapsed time, progress, and any preparation error.",
        parameters: { type: "object", properties: {}, additionalProperties: false }
    },
    {
        name: "start_journey",
        description: "Start or restart the deterministic 35-second Earth-to-Gaia visual preset. The headset owns its timing; do not narrate it.",
        parameters: {
            type: "object",
            properties: {
                journey: { type: "string", enum: ["earth_to_gaia"] },
            },
            required: ["journey"],
            additionalProperties: false,
        }
    },
    {
        name: "control_journey",
        description: "Pause, resume, or stop the active Earth-to-Gaia visual preset.",
        parameters: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    enum: ["pause", "resume", "stop"],
                },
            },
            required: ["action"],
            additionalProperties: false,
        }
    },
    {
        name: "set_navigation",
        description: "Move to a Solar System body, change between surface/orbit/free placement, or set the universal 1:N physical-metres-per-headset-metre scale denominator.",
        parameters: {
            type: "object",
            properties: {
                mode: { type: "string", enum: ["surface", "orbit", "free"] },
                focus_body: {
                    type: "string",
                    enum: ["sun", "mercury", "venus", "earth", "moon", "mars", "jupiter", "saturn", "uranus", "neptune"],
                },
                scale_denominator: {
                    type: "number",
                    exclusiveMinimum: 0,
                    description: "The N in 1:N; physical metres represented by one headset metre.",
                },
                time: {
                    type: "number",
                    minimum: 0,
                    description: "Optional eased transition duration in seconds. Zero or omission is instant.",
                },
            },
            additionalProperties: false,
        }
    },
    {
        name: "get_user_location",
        description: "Read the authoritative high-precision WGS 84 coordinates, display " +
            "scale, and detailed approximate reverse-geocoded place context " +
            "currently under the user’s feet.",
        parameters: { type: "object", properties: {}, additionalProperties: false }
    },
    {
        name: "set_user_location",
        description: "Move the globe so a latitude and longitude are directly under the user’s feet.",
        parameters: {
            type: "object",
            properties: {
                latitude_degrees: {
                    type: "number",
                    minimum: -90,
                    maximum: 90,
                    description: "Latitude in decimal degrees, north positive.",
                },
                longitude_degrees: {
                    type: "number",
                    minimum: -180,
                    maximum: 180,
                    description: "Longitude in decimal degrees, east positive.",
                },
                time: {
                    type: "number",
                    minimum: 0,
                    description: "Optional eased transition duration in seconds. Zero or omission is instant.",
                },
            },
            required: ["latitude_degrees", "longitude_degrees"],
            additionalProperties: false,
        }
    },
    {
        name: "lookup_location",
        description: "Resolve a spoken place name or address into ranked latitude/longitude candidates before moving there or dropping a pin.",
        parameters: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    minLength: 1,
                    description: "The place name or address as spoken, including country or region when supplied.",
                },
            },
            required: ["query"],
            additionalProperties: false,
        }
    },
    {
        name: "get_location_pins",
        description: "List the current XR session’s labeled Earth pins, exact coordinates, distances, visibility, and guidance state.",
        parameters: { type: "object", properties: {}, additionalProperties: false }
    },
    {
        name: "add_location_pin",
        description: "Add and show a labeled Earth pin at exact coordinates for the current XR session.",
        parameters: {
            type: "object",
            properties: {
                label: { type: "string", minLength: 1 },
                latitude_degrees: {
                    type: "number",
                    minimum: -90,
                    maximum: 90,
                },
                longitude_degrees: {
                    type: "number",
                    minimum: -180,
                    maximum: 180,
                },
            },
            required: ["label", "latitude_degrees", "longitude_degrees"],
            additionalProperties: false,
        }
    },
    {
        name: "remove_location_pin",
        description: "Remove one location pin by the pin ID returned by get_location_pins.",
        parameters: {
            type: "object",
            properties: { pin_id: { type: "string", minLength: 1 } },
            required: ["pin_id"],
            additionalProperties: false,
        }
    },
    {
        name: "set_location_pin_visibility",
        description: "Show or hide one current-session location pin without forgetting it. Hidden pins can be shown again later in the same XR session.",
        parameters: {
            type: "object",
            properties: {
                pin_id: { type: "string", minLength: 1 },
                visible: { type: "boolean" },
            },
            required: ["pin_id", "visible"],
            additionalProperties: false,
        }
    },
    {
        name: "rename_location_pin",
        description: "Rename one current-session location pin without changing its coordinates, visibility, or guidance state.",
        parameters: {
            type: "object",
            properties: {
                pin_id: { type: "string", minLength: 1 },
                new_label: { type: "string", minLength: 1 },
            },
            required: ["pin_id", "new_label"],
            additionalProperties: false,
        }
    },
    {
        name: "set_location_pin_guidance",
        description: "Enable or disable off-screen guidance for one existing location pin without changing guidance for other pins.",
        parameters: {
            type: "object",
            properties: {
                pin_id: { type: "string", minLength: 1 },
                enabled: { type: "boolean" },
            },
            required: ["pin_id", "enabled"],
            additionalProperties: false,
        }
    },
    {
        name: "get_view_direction",
        description: "Read the direction the user is looking as a compass heading in degrees clockwise from geographic north.",
        parameters: { type: "object", properties: {}, additionalProperties: false }
    },
    {
        name: "set_view_direction",
        description: "Rotate the virtual world around the user. Use absolute to face a compass heading (0 north, 90 east, 180 south, 270 west), or relative to turn by signed degrees (positive clockwise/right, negative left).",
        parameters: {
            type: "object",
            properties: {
                mode: {
                    type: "string",
                    enum: ["absolute", "relative"],
                    description: "Whether degrees is a compass heading or a signed relative turn.",
                },
                degrees: {
                    type: "number",
                    description: "Compass heading for absolute mode, or signed clockwise turn for relative mode.",
                },
            },
            required: ["mode", "degrees"],
            additionalProperties: false,
        }
    },
    {
        name: "get_amazon_forest_outlines",
        description: "Read the available and currently visible Amazon forest outline years.",
        parameters: { type: "object", properties: {}, additionalProperties: false }
    },
    {
        name: "set_amazon_forest_outline_visibility",
        description: "Show or hide one available Amazon forest outline year without changing any other year.",
        parameters: {
            type: "object",
            properties: {
                year: { type: "integer" },
                visible: { type: "boolean" },
            },
            required: ["year", "visible"],
            additionalProperties: false,
        }
    },
    {
        name: "get_celestial_visibility",
        description: "Read which Solar System sky objects are currently shown: the Sun, Moon, and each planet.",
        parameters: { type: "object", properties: {}, additionalProperties: false }
    },
    {
        name: "set_celestial_visibility",
        description: "Show or hide one Solar System body or a celestial group without changing the background stars.",
        parameters: {
            type: "object",
            properties: {
                target: {
                    type: "string",
                    enum: [
                        "sun",
                        "moon",
                        "mercury",
                        "venus",
                        "mars",
                        "jupiter",
                        "saturn",
                        "uranus",
                        "neptune",
                        "sun_and_moon",
                        "planets",
                        "all",
                    ],
                },
                enabled: { type: "boolean" },
            },
            required: ["target", "enabled"],
            additionalProperties: false,
        }
    },
    {
        name: "search_wikipedia",
        description: "Search English Wikipedia for stable encyclopedic or background facts. Returns substantive article intro summaries plus quiet citation provenance.",
        parameters: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    minLength: 1,
                    description: "A focused non-blank encyclopedic search query.",
                },
            },
            required: ["query"],
            additionalProperties: false,
        }
    },
    {
        name: "search_web",
        description: "Search the live web for current, recent, or niche information. Returns a substantive concise answer with source-attributed evidence and quiet citation provenance.",
        parameters: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    minLength: 1,
                    description: "A focused non-blank web search query.",
                },
            },
            required: ["query"],
            additionalProperties: false,
        }
    },
    {
        name: "get_tile_debug_controls",
        description: "Read every current terrain and texture tile-debug control, including effective target zooms.",
        parameters: { type: "object", properties: {}, additionalProperties: false }
    },
    {
        name: "get_tile_planner_state",
        description: "Read terrain and texture planner, horizon-culling, payload-request, and source-fetch state. Use this for loading progress, queued or in-flight work, completion, failures, and scheduler health. Tile payload requests and shared provider source jobs are distinct layers.",
        parameters: { type: "object", properties: {}, additionalProperties: false }
    },
    {
        name: "set_tile_pixel_ratio",
        description: "Set screen pixels per source pixel for terrain, textures, or both. Larger values select coarser topology.",
        parameters: {
            type: "object",
            properties: {
                target: {
                    type: "string",
                    enum: ["terrain", "textures", "both"],
                },
                screen_pixels_per_source_pixel: {
                    type: "number",
                    exclusiveMinimum: 0,
                },
            },
            required: ["target", "screen_pixels_per_source_pixel"],
            additionalProperties: false,
        }
    },
    {
        name: "set_tile_max_zoom",
        description: "Enable a topology maximum zoom for terrain, textures, or both, or disable it to restore the uncapped default.",
        parameters: {
            type: "object",
            properties: {
                target: {
                    type: "string",
                    enum: ["terrain", "textures", "both"],
                },
                enabled: { type: "boolean" },
                max_zoom: { type: "integer", minimum: 0 },
            },
            required: ["target", "enabled"],
            additionalProperties: false,
        }
    },
    {
        name: "set_tile_recalculation",
        description: "Enable or freeze topology-target recalculation for terrain, textures, or both. Geometric horizon culling continues following observer location and eye height.",
        parameters: {
            type: "object",
            properties: {
                target: {
                    type: "string",
                    enum: ["terrain", "textures", "both"],
                },
                enabled: { type: "boolean" },
            },
            required: ["target", "enabled"],
            additionalProperties: false,
        }
    }
] as const satisfies readonly VoiceToolContract[];
export const ECLIPSE_VOICE_TOOLS = [
    {
        name: "get_eclipse_state",
        description: "Read the verified selected solar eclipse, current UTC, playback, Earth-orbital altitude, physical scale, and shadow state.",
        parameters: emptyParameters
    },
    {
        name: "find_solar_eclipses",
        description: "Find verified global solar eclipses in a UTC date range before selecting one.",
        parameters: {
            type: "object",
            properties: {
                start_utc: { type: "string", description: "Inclusive ISO 8601 UTC start." },
                end_utc: { type: "string", description: "Exclusive ISO 8601 UTC end." },
            },
            required: ["start_utc", "end_utc"],
            additionalProperties: false,
        }
    },
    {
        name: "select_solar_eclipse",
        description: "Select an exact verified event_id returned by find_solar_eclipses.",
        parameters: {
            type: "object",
            properties: { event_id: { type: "string", minLength: 1 } },
            required: ["event_id"],
            additionalProperties: false,
        }
    },
    {
        name: "set_eclipse_time",
        description: "Set the selected eclipse simulation to an ISO 8601 UTC instant within 24 hours of its peak.",
        parameters: {
            type: "object",
            properties: { utc: { type: "string" } },
            required: ["utc"],
            additionalProperties: false,
        }
    },
    {
        name: "set_eclipse_playback",
        description: "Play or pause the selected eclipse timeline.",
        parameters: {
            type: "object",
            properties: { playing: { type: "boolean" } },
            required: ["playing"],
            additionalProperties: false,
        }
    },
    {
        name: "set_eclipse_scale",
        description: "Set the positive universal 1:N scale denominator while preserving all physical Earth–Moon geometry and the observer’s physical position.",
        parameters: {
            type: "object",
            properties: {
                scale_denominator: { type: "number", exclusiveMinimum: 0 },
            },
            required: ["scale_denominator"],
            additionalProperties: false,
        }
    },
    {
        name: "reset_eclipse_stage",
        description: "Return the observer to the default Earth-orbital scale and distance without changing eclipse or time.",
        parameters: emptyParameters
    },
    {
        name: "search_wikipedia",
        description: "Search English Wikipedia for stable eclipse background facts.",
        parameters: {
            type: "object",
            properties: { query: { type: "string", minLength: 1 } },
            required: ["query"],
            additionalProperties: false,
        }
    },
    {
        name: "search_web",
        description: "Search the live web for current, recent, or niche eclipse information.",
        parameters: {
            type: "object",
            properties: { query: { type: "string", minLength: 1 } },
            required: ["query"],
            additionalProperties: false,
        }
    }
] as const satisfies readonly VoiceToolContract[];
