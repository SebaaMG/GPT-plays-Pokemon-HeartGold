const {
    MARKDOWN_TILES,
    PLAYER_ORIENTATION_TILES,
    FALLBACK,
    SYM_PLAYER,
    SYM_UNKNOWN,
    NPC_ID,
} = require('../constants/tiles');
const { state } = require('../state/stateManager');

const mdRow = (cells) => `| ${cells.join("|")} |`;
const mdSep = (n) => `| ${Array(n).fill("---").join("|")} |`;


/**
 * Convertit la grille « visible » (9×10 méta‑tuiles) en Markdown.
 * @param {number[][]} grid   tableau 2‑D d'ID de méta‑tuile
 * @param {number}     px     coordonnée monde X du joueur
 * @param {number}     py     coordonnée monde Y du joueur
 * @param {number}     map_id Current map ID
 * @param {string}     map_name Current map name
 * @param {number}     map_height Current map height
 * @param {number}     map_width Current map width
 */
function gameAreaToMarkdown(
    grid,
    px,
    py,
    map_id,
    map_name,
    map_height,
    map_width,
    originX = null,
    originY = null,
    playerOrientationId = null,
    npcEntries = null
) {
    if (!Array.isArray(grid) || !grid.length) return "## Visible Game Area\n_Aucune donnée_\n";

    const H = grid.length, W = grid[0].length;
    const hasOrigin = Number.isFinite(originX) && Number.isFinite(originY);

    // Legacy format assumed a centered player at (4,4) for a 9x10 grid.
    // Use `originX/originY` when available so each cell can show world coordinates.
    const defaultLocalRow = 4;
    const defaultLocalCol = 4;
    const computedLocalRow = hasOrigin && Number.isFinite(py) ? py - originY : defaultLocalRow;
    const computedLocalCol = hasOrigin && Number.isFinite(px) ? px - originX : defaultLocalCol;
    const localRow = Number.isFinite(computedLocalRow) && computedLocalRow >= 0 && computedLocalRow < H ? computedLocalRow : defaultLocalRow;
    const localCol = Number.isFinite(computedLocalCol) && computedLocalCol >= 0 && computedLocalCol < W ? computedLocalCol : defaultLocalCol;

    const worldXAt = (c) => (hasOrigin ? originX + c : px + (c - localCol));
    const worldYAt = (r) => (hasOrigin ? originY + r : py + (r - localRow));

    const header = [" Y \\ X ", ...Array(W).fill().map((_, c) => String(worldXAt(c)))];
    const out = [
        `## Visible Game Area (${H}x${W} Meta‑Tiles)`,
        `This is the current viewport-aligned map overlay from decoded RAM/ROM/observed fog. Use the DS screenshot for visual detail and NPC/menu/dialog interpretation.`,
        `Unknown cells mean not decoded or not learned by fog yet; they are not visual proof of walls or empty space. This shows only ${H}x${W} nearby tiles, not the entire map.`,
        `Refer to "explored_map" for the entire map.`,
        `Player Position (Map Coords): X=${px}, Y=${py}`,
        `Map Name: ${map_name}`,
        `Observed Grid Size: ${map_width}x${map_height} (not verified full map size)\n`,
        mdRow(header),
        mdSep(header.length),
    ];


    // --- Marker Duplicate Handling (copié de minimapToMarkdown) ---
    const mapMarkers = state.markers[map_id] || {};
    const emojiCounts = {};
    const markerLocations = {}; // { 'x_y': {emoji, label} }
    // On ne compte que les markers visibles dans la zone 9x10
    for (let r = 0; r < H; r++) {
        for (let c = 0; c < W; c++) {
            const worldX = worldXAt(c);
            const worldY = worldYAt(r);
            const markerKey = `${worldX}_${worldY}`;
            const marker = mapMarkers[markerKey];
            if (marker) {
                emojiCounts[marker.emoji] = (emojiCounts[marker.emoji] || 0) + 1;
                markerLocations[markerKey] = marker;
            }
        }
    }
    const duplicateEmojis = new Set(Object.keys(emojiCounts).filter(emoji => emojiCounts[emoji] > 1));
    const numberedMarkerSymbols = {}; // { 'x_y': 'emoji[index]' }
    const emojiCurrentIndex = {}; // { 'emoji': last_index_used }
    // Assign indices to duplicate markers (dans l'ordre des positions)
    const sortedMarkerKeys = Object.keys(markerLocations).sort();
    for (const key of sortedMarkerKeys) {
        const marker = markerLocations[key];
        if (duplicateEmojis.has(marker.emoji)) {
            emojiCurrentIndex[marker.emoji] = (emojiCurrentIndex[marker.emoji] || 0) + 1;
            numberedMarkerSymbols[key] = `${marker.emoji}[${emojiCurrentIndex[marker.emoji]}]`;
        }
    }
    // --- Fin gestion des doublons ---

    // 1) Tableau
    const uniqueValues = new Set(grid.flat()); // Get unique tile IDs from the visible area
    const visibleMarkers = new Map(); // Store visible markers for the legend { emoji ou emoji[index]: {label, x, y} }
    const tileIdByCoord = new Map(); // { 'x_y': tileId } for the visible area

    for (let r = 0; r < H; r++) {
        const worldY = worldYAt(r);
        const row = [`${worldY}`];
        for (let c = 0; c < W; c++) {
            const worldX = worldXAt(c);
            const id = grid[r][c];
            const baseSymb = (MARKDOWN_TILES[id] || FALLBACK)[0]; // Get base tile symbol first
            const isPlayerTile = Number(worldX) === Number(px) && Number(worldY) === Number(py);
            const playerSymb =
                playerOrientationId && PLAYER_ORIENTATION_TILES[playerOrientationId]
                    ? PLAYER_ORIENTATION_TILES[playerOrientationId][0]
                    : SYM_PLAYER[0];

            // Check for marker
            const markerKey = `${worldX}_${worldY}`;
            tileIdByCoord.set(markerKey, id);
            const marker = mapMarkers[markerKey];
            let markerSymbol = "";
            if (marker) {
                if (numberedMarkerSymbols[markerKey]) {
                    markerSymbol = numberedMarkerSymbols[markerKey];
                } else {
                    markerSymbol = marker.emoji;
                }
                // Utiliser le symbole unique (plain ou indexé) comme clé pour visibleMarkers
                if (!visibleMarkers.has(markerSymbol)) {
                    visibleMarkers.set(markerSymbol, { label: marker.label, x: worldX, y: worldY });
                }
            }

            // IMPORTANT: do not replace the underlying tile with the player symbol.
            // We append the player's orientation glyph so the tile remains visible.
            const symb = `${baseSymb}${isPlayerTile ? playerSymb : ""}${markerSymbol}`;
            const cellText = `${symb} (${worldX}x${worldY})`;
            row.push(cellText);
        }
        out.push(mdRow(row));
    }

    // 2) Légende
    const legendSeen = new Set();
    const customMarkerLegendLines = ["\n### Custom Markers (Visible) - Markers set with the 'add_marker' tool"];
    const npcLegendLines = ["\n### NPCs (Visible Area)"];
    const mapLegendLines = ["\n### Map Legend (Visible Area)"];

    // Add visible custom markers to their legend (avec indexation)
    // Trier les clés pour l'ordre d'affichage
    const sortedVisibleMarkerKeys = [...visibleMarkers.keys()].sort();
    for (const markerSymbol of sortedVisibleMarkerKeys) {
        const markerData = visibleMarkers.get(markerSymbol);
        const { label, x: markerX, y: markerY } = markerData;
        const legendText = `${label} (${markerX}x${markerY}) (Custom Marker)`;
        customMarkerLegendLines.push(`- ${markerSymbol} : ${legendText}`);
    }

    // NPC list (position -> name) for the visible area.
    // We only include NPCs that are currently represented as the generic NPC tile (👤) on the grid.
    if (Array.isArray(npcEntries) && npcEntries.length > 0) {
        const npcsInArea = [];
        for (const npc of npcEntries) {
            if (!npc || typeof npc !== "object") continue;
            if (npc.isActive === false) continue;

            const xRaw = Number.isFinite(Number(npc.x))
                ? Number(npc.x)
                : Array.isArray(npc.position)
                    ? Number(npc.position[0])
                    : NaN;
            const yRaw = Number.isFinite(Number(npc.y))
                ? Number(npc.y)
                : Array.isArray(npc.position)
                    ? Number(npc.position[1])
                    : NaN;
            if (!Number.isFinite(xRaw) || !Number.isFinite(yRaw)) continue;

            const key = `${xRaw}_${yRaw}`;
            if (!tileIdByCoord.has(key)) continue;
            if (tileIdByCoord.get(key) !== NPC_ID) continue;

            const name = typeof npc.type === "string" ? npc.type : typeof npc.name === "string" ? npc.name : "UNKNOWN";
            const localId = Number.isFinite(Number(npc.localId)) ? Number(npc.localId) : null;
            const elevation = Number.isFinite(Number(npc.elevation)) ? Number(npc.elevation) : null;
            npcsInArea.push({ x: xRaw, y: yRaw, name, localId, elevation });
        }

        npcsInArea.sort((a, b) => (a.y !== b.y ? a.y - b.y : a.x - b.x));
        for (const npc of npcsInArea) {
            npcLegendLines.push(`- (${npc.x}x${npc.y}) : ${npc.name}`);
        }
    }

    // Player legend entry (use orientation symbol like explored_map).
    const [playerLegendSymb, playerLegendDesc] =
        playerOrientationId && PLAYER_ORIENTATION_TILES[playerOrientationId]
            ? PLAYER_ORIENTATION_TILES[playerOrientationId]
            : SYM_PLAYER;
    if (!legendSeen.has(playerLegendDesc)) {
        mapLegendLines.push(`- ${playerLegendSymb} : ${playerLegendDesc}`);
        legendSeen.add(playerLegendDesc);
    }

    // Add every tile ID actually visible (including NPC-specific IDs), sorted
    const visibleIds = [...uniqueValues].sort((a, b) => a - b);
    const allDefinedIds = new Set(Object.keys(MARKDOWN_TILES).map(Number));
    let unknownPresent = false;

    for (const id of visibleIds) {
        if (allDefinedIds.has(id)) {
            const [symb, desc] = MARKDOWN_TILES[id] || FALLBACK;
            if (!legendSeen.has(desc)) {
                mapLegendLines.push(`- ${symb} : ${desc}`);
                legendSeen.add(desc);
            }
        } else {
            unknownPresent = true;
        }
    }

    // If any visible tile is not defined, add a fallback legend entry
    if (unknownPresent) {
        const [symb, desc] = FALLBACK;
        if (!legendSeen.has(desc)) {
            mapLegendLines.push(`- ${symb} : ${desc}`);
            legendSeen.add(desc);
        }
    }

    // Append legends if they have content
    if (customMarkerLegendLines.length > 1) {
        out.push(...customMarkerLegendLines);
    }
    if (npcLegendLines.length > 1) {
        out.push(...npcLegendLines);
    }
    if (mapLegendLines.length > 1) {
        out.push(...mapLegendLines);
    }

    return out.join("\n");
}

/**
 * Convertit la minimap complète (JSON) en Markdown.
 * @param {{width:number,height:number,grid:number[][]}} mm
 * @param {number}     px     coordonnée monde X du joueur
 * @param {number}     py     coordonnée monde Y du joueur
 * @param {number}     map_id Current map ID
 * @param {string}     map_name Current map name
 * @param {number|null} playerOrientationId Player orientation tile ID (100-103) or null
 * @param {number[][]} gameAreaGrid The grid data from the visible game area (e.g., 9x10)
 * @param {number}     gameAreaLocalPlayerRow Player's row index within gameAreaGrid (e.g., 4)
 * @param {number}     gameAreaLocalPlayerCol Player's column index within gameAreaGrid (e.g., 4)
 * @param {boolean}    isPathFinding Whether this is a pathfinding request
 */
function minimapToMarkdown(mm, minimapPlayerX, minimapPlayerY, map_id, map_name, playerOrientationId, gameAreaGrid, gameAreaLocalPlayerRow, gameAreaLocalPlayerCol, npcEntries = null, isPathFinding = false) {
    if (!mm || !mm.grid) return "## Explored Map State\n_Aucune donnée_\n";

    const minimapGrid = mm.grid;
    const inferredH = Array.isArray(minimapGrid) ? minimapGrid.length : 0;
    const inferredW = inferredH > 0 && Array.isArray(minimapGrid[0]) ? minimapGrid[0].length : 0;
    const W = Number.isFinite(Number(mm.width)) ? Number(mm.width) : inferredW;
    const H = Number.isFinite(Number(mm.height)) ? Number(mm.height) : inferredH;
    const originX = Number.isFinite(Number(mm.origin_x)) ? Number(mm.origin_x) : 0;
    const originY = Number.isFinite(Number(mm.origin_y)) ? Number(mm.origin_y) : 0;
    const worldXAt = (x) => originX + x;
    const worldYAt = (y) => originY + y;
    const gridIdAtWorld = (worldX, worldY) => minimapGrid[worldY - originY]?.[worldX - originX];
    const header = [" Y \ X ", ...Array(W).fill().map((_, x) => String(worldXAt(x)))];

    // Determine gameAreaGrid dimensions safely
    const gameAreaHeight = Array.isArray(gameAreaGrid) ? gameAreaGrid.length : 0;
    const gameAreaWidth = gameAreaHeight > 0 && Array.isArray(gameAreaGrid[0]) ? gameAreaGrid[0].length : 0;

    // --- Marker Duplicate Handling ---
    const mapMarkers = state.markers[map_id] || {};
    const emojiCounts = {};
    const markerLocations = {}; // { 'x_y': {emoji, label} }
    for (const key in mapMarkers) {
        const marker = mapMarkers[key];
        emojiCounts[marker.emoji] = (emojiCounts[marker.emoji] || 0) + 1;
        markerLocations[key] = marker; // Store marker data by location key
    }
    const duplicateEmojis = new Set(Object.keys(emojiCounts).filter(emoji => emojiCounts[emoji] > 1));
    const numberedMarkerSymbols = {}; // { 'x_y': 'emoji[index]' }
    const emojiCurrentIndex = {}; // { 'emoji': last_index_used }

    // Assign indices to duplicate markers
    // Sort keys for consistent indexing (optional but good practice)
    const sortedMarkerKeys = Object.keys(markerLocations).sort();
    for (const key of sortedMarkerKeys) {
        const marker = markerLocations[key];
        if (duplicateEmojis.has(marker.emoji)) {
            emojiCurrentIndex[marker.emoji] = (emojiCurrentIndex[marker.emoji] || 0) + 1;
            numberedMarkerSymbols[key] = `${marker.emoji}[${emojiCurrentIndex[marker.emoji]}]`;
        }
    }
    // --- End Marker Duplicate Handling ---


    const out = [
        "## Current Map State",
        `This is the layout of the current map, filled in while exploring.`,
        `Every '❓' represents tiles you haven't explored yet. You need to explore them to discover doors, stairs, etc. Otherwise they won't appear on the map.`,
        `Player Position (Map Coords): X=${minimapPlayerX}, Y=${minimapPlayerY}`,
        `Map Name: ${map_name}`,
        `Observed Explored Grid Size: ${W}x${H} (not verified full map size)\n`,
        mdRow(header),
        mdSep(header.length),
    ];

    // 1) Tableau
    const uniqueValues = new Set(); // For the map legend
    let hasUnexplored = false;
    let haveBoulders = false; // Boulder puzzle hinting
    let haveTeleporters = false; // Warp/teleporter hinting
    let haveIceTiles = false; // Thin/Cracked ice hinting
    let haveSpinners = false; // Spinner tiles hinting
    let haveDirectionalBlockedGround = false; // One-way edge collision on walkable ground
    const visibleMarkers = new Map(); // Store markers visible on the minimap { 'emoji' or 'emoji[index]': {label, x, y} }

    for (let y = 0; y < H; y++) {
        const worldY = worldYAt(y);
        const row = [`${worldY}`];
        for (let x = 0; x < W; x++) {
            const worldX = worldXAt(x);
            // Calculate offset from player's *world* position (which is minimapPlayerX/Y)
            const deltaX = worldX - minimapPlayerX;
            const deltaY = worldY - minimapPlayerY;

            // Calculate corresponding *local* coordinates within gameAreaGrid
            const gameAreaRow = gameAreaLocalPlayerRow + deltaY;
            const gameAreaCol = gameAreaLocalPlayerCol + deltaX;

            let id; // Tile ID to use for symbol determination

            // Check if this minimap coordinate (x, y) is within the bounds of the visible gameAreaGrid
            if (gameAreaGrid &&
                gameAreaRow >= 0 && gameAreaRow < gameAreaHeight &&
                gameAreaCol >= 0 && gameAreaCol < gameAreaWidth) {
                id = gameAreaGrid[gameAreaRow][gameAreaCol];
                if (id != null) {
                    uniqueValues.add(id);
                }
            } else {
                id = gridIdAtWorld(worldX, worldY);
                if (id == null) {
                    hasUnexplored = true;
                } else {
                    uniqueValues.add(id);
                }
            }

            if (id === 33) {
                haveBoulders = true;
            }
            if (id === 9 || id === 32) {
                haveTeleporters = true;
            }
            if (id === 48 || id === 49) {
                haveIceTiles = true;
            }
            if (id >= 60 && id <= 64) {
                haveSpinners = true;
            }
            if (id >= 68 && id <= 75) {
                haveDirectionalBlockedGround = true;
            }

            let symb;
            let originalSymb;

            if (worldX === minimapPlayerX && worldY === minimapPlayerY) {
                originalSymb = (playerOrientationId && PLAYER_ORIENTATION_TILES[playerOrientationId])
                    ? PLAYER_ORIENTATION_TILES[playerOrientationId][0]
                    : SYM_PLAYER[0];
            } else if (id == null) {
                originalSymb = SYM_UNKNOWN[0];
            } else {
                originalSymb = (MARKDOWN_TILES[id] || FALLBACK)[0];
            }

            const markerKey = `${worldX}_${worldY}`;
            const marker = mapMarkers[markerKey];
            let markerSymbol = "";

            if (marker) {
                markerSymbol = numberedMarkerSymbols[markerKey] || marker.emoji;
                symb = originalSymb + markerSymbol;
                if (!visibleMarkers.has(markerSymbol)) {
                    visibleMarkers.set(markerSymbol, { label: marker.label, x: worldX, y: worldY });
                }
            } else {
                symb = originalSymb;
            }

            row.push(`${symb}${worldX}x${worldY}`);
        }
        out.push(mdRow(row));
    }

    // 2) Légende
    const legendSeen = new Set();
    const customMarkerLegendLines = ["\n### Custom Markers (Minimap) - Markers set with the 'add_marker' tool"];
    const npcLegendLines = ["\n### NPCs (Explored Map)"];
    const mapLegendLines = ["\n### Legend (Explored Map)"];

    // Add visible custom markers to their legend
    // Sort the marker keys (symbols) for consistent legend order
    const sortedVisibleMarkerKeys = [...visibleMarkers.keys()].sort();

    for (const markerSymbol of sortedVisibleMarkerKeys) { // Iterate using the unique symbol (plain or numbered)
        const markerData = visibleMarkers.get(markerSymbol);
        const { label, x: markerX, y: markerY } = markerData; // Use coords from markerData
        const legendText = `${label} (${markerX}x${markerY}) (Custom Marker)`;
        // Legend entry uses the markerSymbol (which might be indexed)
        customMarkerLegendLines.push(`- ${markerSymbol} : ${legendText}`);
        // No need for legendSeen check here as markerSymbol keys are unique
    }

    // NPC list (position -> name) for the explored map.
    // Only include NPCs that are represented as the generic NPC tile (👤) in the minimap display.
    const displayedTileIdAt = (x, y) => {
        const deltaX = x - minimapPlayerX;
        const deltaY = y - minimapPlayerY;
        const gameAreaRow = gameAreaLocalPlayerRow + deltaY;
        const gameAreaCol = gameAreaLocalPlayerCol + deltaX;

        if (gameAreaGrid &&
            gameAreaRow >= 0 && gameAreaRow < gameAreaHeight &&
            gameAreaCol >= 0 && gameAreaCol < gameAreaWidth) {
            return gameAreaGrid[gameAreaRow]?.[gameAreaCol];
        }
        return gridIdAtWorld(x, y);
    };

    if (Array.isArray(npcEntries) && npcEntries.length > 0) {
        const npcsOnMap = [];
        for (const npc of npcEntries) {
            if (!npc || typeof npc !== "object") continue;
            if (npc.isActive === false) continue;

            const xRaw = Number.isFinite(Number(npc.x))
                ? Number(npc.x)
                : Array.isArray(npc.position)
                    ? Number(npc.position[0])
                    : NaN;
            const yRaw = Number.isFinite(Number(npc.y))
                ? Number(npc.y)
                : Array.isArray(npc.position)
                    ? Number(npc.position[1])
                    : NaN;
            if (!Number.isFinite(xRaw) || !Number.isFinite(yRaw)) continue;
            if (xRaw < originX || xRaw >= originX + W || yRaw < originY || yRaw >= originY + H) continue;

            if (displayedTileIdAt(xRaw, yRaw) !== NPC_ID) continue;

            const name = typeof npc.type === "string" ? npc.type : typeof npc.name === "string" ? npc.name : "UNKNOWN";
            const localId = Number.isFinite(Number(npc.localId)) ? Number(npc.localId) : null;
            const elevation = Number.isFinite(Number(npc.elevation)) ? Number(npc.elevation) : null;
            npcsOnMap.push({ x: xRaw, y: yRaw, name, localId, elevation });
        }

        npcsOnMap.sort((a, b) => (a.y !== b.y ? a.y - b.y : a.x - b.x));
        for (const npc of npcsOnMap) {
            npcLegendLines.push(`- (${npc.x}x${npc.y}) : ${npc.name}`);
        }
    }

    // Collect important transitions without custom markers
    // (door / ladder / escalator / stairs / entrance / warp)
    const doorLadderIds = new Set([26, 27, 28, 30, 31, 32]);
    const doorsLaddersWithoutMarkers = [];

    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const worldX = worldXAt(x);
            const worldY = worldYAt(y);
            // Calculate offset from player's world position
            const deltaX = worldX - minimapPlayerX;
            const deltaY = worldY - minimapPlayerY;
            const gameAreaRow = gameAreaLocalPlayerRow + deltaY;
            const gameAreaCol = gameAreaLocalPlayerCol + deltaX;

            let id;
            // Check if this coordinate is within the visible game area
            if (gameAreaGrid &&
                gameAreaRow >= 0 && gameAreaRow < gameAreaHeight &&
                gameAreaCol >= 0 && gameAreaCol < gameAreaWidth) {
                id = gameAreaGrid[gameAreaRow][gameAreaCol];
            } else {
                id = gridIdAtWorld(worldX, worldY);
            }

            // Check if this tile is a door/ladder and doesn't have a custom marker
            if (id != null && doorLadderIds.has(id)) {
                const markerKey = `${worldX}_${worldY}`;
                const hasMarker = mapMarkers[markerKey];

                if (!hasMarker) {
                    const [symb, desc] = MARKDOWN_TILES[id] || FALLBACK;
                    doorsLaddersWithoutMarkers.push({
                        x: worldX,
                        y: worldY,
                        symbol: symb,
                        description: desc
                    });
                }
            }
        }
    }

    // Create the doors/ladders without markers section
    const doorsLaddersLegendLines = [
        "\n### Doors / Ladders Without Custom Markers"
    ];
    if (doorsLaddersWithoutMarkers.length > 0) {
        doorsLaddersLegendLines.push("_These are doors, stairs, or ladders that do not have a custom marker placed directly on them. This usually means they are either unexplored, or a marker was placed in front of them instead of on the actual tile. Please check and place markers directly on the door, stairs, or ladder tile for accurate tracking, or visit them to set the needed marker._");
        // Sort by y then x for consistent ordering
        doorsLaddersWithoutMarkers.sort((a, b) => {
            if (a.y !== b.y) return a.y - b.y;
            return a.x - b.x;
        });

        for (const item of doorsLaddersWithoutMarkers) {
            doorsLaddersLegendLines.push(`- ${item.symbol} : ${item.description} (${item.x}x${item.y})`);
        }
    }

    // Add Player symbol (with orientation) to map legend
    const [playerSymb, playerDesc] = (playerOrientationId && PLAYER_ORIENTATION_TILES[playerOrientationId])
        ? PLAYER_ORIENTATION_TILES[playerOrientationId]
        : SYM_PLAYER;
    mapLegendLines.push(`- ${playerSymb} : ${playerDesc}`);
    legendSeen.add(playerDesc);

    // Add Unexplored symbol if present
    if (hasUnexplored) {
        mapLegendLines.push(`- ${SYM_UNKNOWN[0]} : ${SYM_UNKNOWN[1]}`);
        legendSeen.add(SYM_UNKNOWN[1]);
    }

    // Add every unique tile value that appears on the explored minimap (including NPC-specific IDs)
    const visibleIds = Array.from(uniqueValues).sort((a, b) => a - b);
    const allDefinedIds = new Set(Object.keys(MARKDOWN_TILES).map(Number));
    let unknownPresent = false;

    for (const id of visibleIds) {
        if (allDefinedIds.has(id)) {
            const [symb, desc] = MARKDOWN_TILES[id] || FALLBACK;
            if (!legendSeen.has(desc)) {
                mapLegendLines.push(`- ${symb} : ${desc}`);
                legendSeen.add(desc);
            }
        } else {
            unknownPresent = true;
        }
    }

    // Add NPC fallback only if present
    if (visibleIds.includes(NPC_ID)) {
        const [symb, desc] = MARKDOWN_TILES[NPC_ID] || FALLBACK;
        if (!legendSeen.has(desc)) {
            mapLegendLines.push(`- ${symb} : ${desc}`);
            legendSeen.add(desc);
        }
    }

    // Add fallback for unknown tiles if any
    if (unknownPresent) {
        const [symb, desc] = FALLBACK;
        if (!legendSeen.has(desc)) {
            mapLegendLines.push(`- ${symb} : ${desc}`);
            legendSeen.add(desc);
        }
    }


    // Append legends if they have content
    if (customMarkerLegendLines.length > 1) {
        out.push(...customMarkerLegendLines);
    }

    if (npcLegendLines.length > 1) {
        out.push(...npcLegendLines);
    }

    // Add doors/ladders without markers section
    if (doorsLaddersLegendLines.length > 1) {
        out.push(...doorsLaddersLegendLines);
    }

    if (mapLegendLines.length > 1) {
        out.push(...mapLegendLines);
    }

    out.push("\n<navigation_notes>\n");
    out.push("Map symbols describe current decoded collision, terrain, objects, and known markers. Custom markers are player-authored notes and do not affect collision.");
    if (hasUnexplored && !isPathFinding) {
        out.push("Unknown cells are unexplored or not yet decoded; treat them as unknown, not as proof of walls or open space.");
    }
    if (doorsLaddersLegendLines.length > 1) {
        out.push("Doors, stairs, ladders, entrances, and warp-like tiles listed above are current-map observations. Use them as present-state evidence, not as future route guarantees.");
    }
    if (haveTeleporters) {
        out.push("Teleporter tiles trigger map-specific movement or transitions when stepped on; verify the next observation after using one.");
    }
    if (haveDirectionalBlockedGround) {
        out.push("Directional collision tiles are walkable floor with one or more blocked edges. The arrows in the legend indicate blocked crossing directions.");
    }
    if (haveBoulders) {
        out.push("Boulder tiles represent pushable field objects when Strength is active. Use current collision, position, and screenshot evidence before moving them.");
    }
    if (haveIceTiles) {
        out.push("Thin or cracked ice tiles may change after stepping on them. Treat their current map symbols as the latest decoded state.");
    }
    if (haveSpinners) {
        out.push("Spinner tiles move the avatar automatically according to their arrow until the mechanic stops; reassess from the next fresh observation.");
    }
    out.push("If map data and screenshot disagree, treat it as an observation conflict rather than forcing a route.");
    out.push("</navigation_notes>\n");

    return out.join("\n");
}

/**
 * Searches for the player tile ID in the game area to determine orientation
 * @param {Array} gameAreaGrid Game area grid
 * @param {number} localRow Player row in the grid
 * @param {number} localCol Player column in the grid
 * @returns {number|null} Player tile ID or null if not found
 */
function findPlayerInGameArea(gameAreaGrid, localRow, localCol) {
    // Added safety checks for gameAreaGrid structure
    if (!Array.isArray(gameAreaGrid) || gameAreaGrid.length === 0 || !Array.isArray(gameAreaGrid[0])) {
        console.warn("findPlayerInGameArea called with invalid grid");
        return null;
    }
    const H = gameAreaGrid.length;
    const W = gameAreaGrid[0].length;


    if (localRow >= 0 && localRow < H &&
        localCol >= 0 && localCol < W &&
        gameAreaGrid[localRow][localCol] >= 100 &&
        gameAreaGrid[localRow][localCol] <= 103) {
        return gameAreaGrid[localRow][localCol];
    }

    // Search for the player elsewhere in the grid (case where the player is not centered)
    // This might happen if gameAreaGrid is smaller or player is near edge
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            if (gameAreaGrid[y][x] >= 100 && gameAreaGrid[y][x] <= 103) {
                console.warn(`Player found at non-standard location (${x},${y}) in gameAreaGrid.`);
                return gameAreaGrid[y][x];
            }
        }
    }
    console.warn("Player tile (100-103) not found in gameAreaGrid.");
    return null; // Return null if player tile not found
}

/**
 * Formats MARKDOWN_TILES object into a readable legend string
 * @returns {string} Formatted legend string
 */
function formatTilesLegend() {
    const entries = [];

    // Sort the keys numerically for better readability
    const sortedKeys = Object.keys(MARKDOWN_TILES).sort((a, b) => {
        const numA = isNaN(a) ? parseInt(a) || 999 : parseInt(a);
        const numB = isNaN(b) ? parseInt(b) || 999 : parseInt(b);
        return numA - numB;
    });

    for (const key of sortedKeys) {
        const [emoji, description] = MARKDOWN_TILES[key];
        entries.push(`${key}: ${emoji} ${description}`);
    }

    return entries.join('\n');
}


module.exports = { mdRow, mdSep, gameAreaToMarkdown, minimapToMarkdown, findPlayerInGameArea, formatTilesLegend };
