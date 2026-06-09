const { config } = require("../config");
const { sanitizeFunctionCallArguments, sanitizeModelText, sanitizeModelValue } = require("./modelSurfaceSanitizer");

function cleanTextSections(text, sectionsToRemove) {
  let cleanedText = text;
  if (sectionsToRemove.minimap) {
    cleanedText = cleanedText.replace(/<explored_map>[\s\S]*?<\/explored_map>\s*/g, "");
  }
  if (sectionsToRemove.view_map) {
    cleanedText = cleanedText.replace(/<visible_area>[\s\S]*?<\/visible_area>\s*/g, "");
  }
  if (sectionsToRemove.memory) {
    cleanedText = cleanedText.replace(/<memory>[\s\S]*?<\/memory>\s*/g, "");
    cleanedText = cleanedText.replace(/<markers>[\s\S]*?<\/markers>\s*/g, "");
    cleanedText = cleanedText.replace(/<action_context[\s\S]*?<\/action_context>\s*/g, "");
    cleanedText = cleanedText.replace(/<menu_tips>[\s\S]*?<\/menu_tips>\s*/g, "");
    cleanedText = cleanedText.replace(/<ui_state>[\s\S]*?<\/ui_state>\s*/g, "");
  }
  if (sectionsToRemove.player_data) {
    cleanedText = cleanedText.replace(/<player_stats>[\s\S]*?<\/player_stats>\s*/g, "");
    cleanedText = cleanedText.replace(/<battle_state>[\s\S]*?<\/battle_state>\s*/g, "");
    cleanedText = cleanedText.replace(/<objectives>[\s\S]*?<\/objectives>\s*/g, "");
    cleanedText = cleanedText.replace(/<pc_tips>[\s\S]*?<\/pc_tips>\s*/g, "");
    cleanedText = cleanedText.replace(/<battle_state[\s\S]*?<\/battle_state>\s*/g, "");
  }
  if (sectionsToRemove.pokedex_data) {
    cleanedText = cleanedText.replace(/<pokedex_data>[\s\S]*?<\/pokedex_data>\s*/g, "");
  }
  return cleanedText;
}

function processHistoryForAPI(currentHistory) {
  const sanitizeMessageContent = (message) => {
    if (typeof message.content === "string") {
      message.content = sanitizeModelText(message.content);
      return message;
    }
    if (!Array.isArray(message.content)) return message;
    message.content = message.content.map((item) => {
      if (item && typeof item === "object") {
        if (typeof item.text === "string") return { ...item, text: sanitizeModelText(item.text) };
        return sanitizeModelValue(item);
      }
      return typeof item === "string" ? sanitizeModelText(item) : item;
    });
    return message;
  };

  const sanitizeReasoningContent = (message) => {
    if (typeof message.text === "string") message.text = sanitizeModelText(message.text);
    if (Array.isArray(message.summary)) {
      message.summary = message.summary.map((item) => {
        if (typeof item === "string") return sanitizeModelText(item);
        if (item && typeof item === "object" && typeof item.text === "string") {
          return { ...item, text: sanitizeModelText(item.text) };
        }
        return item;
      });
    }
    return message;
  };

  const isSystemToolReminder = (message) => {
    if (message.role !== "user" || !message.content || !Array.isArray(message.content)) {
      return false;
    }
    return (
      message.content.length === 1 &&
      message.content[0].type === "input_text" &&
      message.content[0].text ===
        "<system>You must include tools in your response ! Always call 'execute_action' tool with your messages to continue your actions !</system>"
    );
  };

  const dataMessageIndices = currentHistory.reduce((acc, message, index) => {
    const isUserDataMessage = message.role && message.role === "user" && !isSystemToolReminder(message);
    const isToolDataMessage = message.type === "function_call_output" && Array.isArray(message.output);
    if (isUserDataMessage || isToolDataMessage) {
      acc.push(index);
    }
    return acc;
  }, []);

  const toolResultIndices = currentHistory.reduce((acc, message, index) => {
    if (message.type === "function_call_output") {
      acc.push(index);
    }
    return acc;
  }, []);

  const minimapKeepIndices = new Set(dataMessageIndices.slice(-config.history.keepLastNUserMessagesWithMinimap));
  const viewMapKeepIndices = new Set(dataMessageIndices.slice(-config.history.keepLastNUserMessagesWithViewMap));
  const detailedDataKeepIndices = new Set(dataMessageIndices.slice(-config.history.keepLastNUserMessagesWithDetailedData));
  const imagesKeepIndices = new Set(dataMessageIndices.slice(-config.history.keepLastNUserMessagesWithImages));
  const toolResultKeepIndices = new Set(toolResultIndices.slice(-config.history.keepLastNToolFullResults));
  const memoryKeepIndices = new Set(dataMessageIndices.slice(-config.history.keepLastNUserMessagesWithMemory));
  const pokedexKeepIndices = new Set(dataMessageIndices.slice(-config.history.keepLastNUserMessagesWithPokedex));

  return currentHistory
    .map((message, index) => {
      let newMessage = JSON.parse(JSON.stringify(message));

      if (newMessage.role === "user") {
        if (isSystemToolReminder(newMessage)) {
          return newMessage;
        }

        let textContentIndex = newMessage.content.findIndex((item) => item.type === "input_text");
        let originalText = textContentIndex !== -1 ? newMessage.content[textContentIndex].text : null;

        if (originalText) {
          let sectionsToRemove = {
            minimap: !minimapKeepIndices.has(index),
            view_map: !viewMapKeepIndices.has(index),
            memory: !memoryKeepIndices.has(index),
            game_area: !detailedDataKeepIndices.has(index),
            player_data: !detailedDataKeepIndices.has(index),
            pokedex_data: !pokedexKeepIndices.has(index),
          };
          newMessage.content[textContentIndex].text = sanitizeModelText(cleanTextSections(originalText, sectionsToRemove));
        }

        if (!imagesKeepIndices.has(index)) {
          newMessage.content = newMessage.content.filter((item) => item.type !== "input_image");
        }
        return newMessage;
      } else if (newMessage.role === "assistant" || newMessage.type === "message") {
        return sanitizeMessageContent(newMessage);
      } else if (newMessage.type === "reasoning") {
        return sanitizeReasoningContent(newMessage);
      } else if (newMessage.type === "function_call_output") {
        const outputItems = Array.isArray(newMessage.output) ? newMessage.output : null;

        if (outputItems) {
          outputItems.forEach((item, itemIndex) => {
            if (item.type === "input_text" && typeof item.text === "string") {
              const sectionsToRemove = {
                minimap: !minimapKeepIndices.has(index),
                view_map: !viewMapKeepIndices.has(index),
                memory: !memoryKeepIndices.has(index),
                game_area: !detailedDataKeepIndices.has(index),
                player_data: !detailedDataKeepIndices.has(index),
              };
              outputItems[itemIndex].text = sanitizeModelText(cleanTextSections(item.text, sectionsToRemove));
            } else {
              outputItems[itemIndex] = sanitizeModelValue(item);
            }
          });

          if (!imagesKeepIndices.has(index)) {
            newMessage.output = outputItems.filter((item) => item.type !== "input_image");
          } else {
            newMessage.output = outputItems;
          }

          if (!toolResultKeepIndices.has(index)) {
            const maxLength = 3200;
            const keepLength = Math.floor(maxLength / 2);
            const firstTextItem = newMessage.output.find(
              (item) => item.type === "input_text" && typeof item.text === "string"
            );
            if (firstTextItem) {
              const text = firstTextItem.text;
              if (text.length > maxLength) {
                firstTextItem.text =
                  text.substring(0, keepLength) +
                  "\n...(truncated)...\n" +
                  text.substring(text.length - keepLength);
              }
            }
          }
        } else if (typeof newMessage.output === "string") {
          if (!toolResultKeepIndices.has(index)) {
            const output = newMessage.output;
            const maxLength = 3200;
            const keepLength = Math.floor(maxLength / 2);
            if (output.length > maxLength) {
              newMessage.output =
                output.substring(0, keepLength) +
                "\n...(truncated)...\n" +
                output.substring(output.length - keepLength);
            }
          }
          newMessage.output = sanitizeModelText(newMessage.output);
        }
        return newMessage;
      } else if (newMessage.type === "function_call") {
        if (typeof newMessage.arguments === "string") {
          newMessage.arguments = sanitizeFunctionCallArguments(newMessage.name, newMessage.arguments);
        }
        return newMessage;
      } else {
        return message;
      }
    })
    .filter((message) => message !== null);
}

module.exports = { cleanTextSections, processHistoryForAPI };

