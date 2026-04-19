// Router for message-component interactions (buttons, select menus).
// Command modules call registerComponent(prefix, handler) at import
// time; src/index.ts calls dispatchComponent() from its
// InteractionCreate listener. Each component's customId is namespaced
// as `<prefix>:<rest>`; the prefix chooses the handler, the rest is
// state passed back on click.
import type {
  ButtonInteraction,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
} from "discord.js";
import log from "./logger.js";

export type ComponentInteraction =
  | ButtonInteraction
  | StringSelectMenuInteraction
  | ModalSubmitInteraction;

type Handler = (interaction: ComponentInteraction) => Promise<void>;

const handlers = new Map<string, Handler>();

export function registerComponent(prefix: string, handler: Handler): void {
  if (handlers.has(prefix)) {
    throw new Error(`Duplicate component handler prefix: ${prefix}`);
  }
  handlers.set(prefix, handler);
}

export async function dispatchComponent(
  interaction: ComponentInteraction,
): Promise<void> {
  const prefix = interaction.customId.split(":")[0];
  const handler = prefix ? handlers.get(prefix) : undefined;
  if (!handler) {
    log.warn({ customId: interaction.customId }, "No handler for component");
    try {
      await interaction.reply({ content: "This control has expired.", ephemeral: true });
    } catch {
      /* interaction may already be gone */
    }
    return;
  }
  try {
    await handler(interaction);
  } catch (err) {
    if ((err as { code?: number })?.code === 10062) return;
    log.error({ customId: interaction.customId, err }, "Component handler error");
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply("Something went wrong handling that control.");
      } else {
        await interaction.reply({
          content: "Something went wrong handling that control.",
          ephemeral: true,
        });
      }
    } catch {
      /* interaction gone */
    }
  }
}
