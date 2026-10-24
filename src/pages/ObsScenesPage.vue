<template>
  <q-page
    class="obs-scenes column no-wrap"
    :class="{ 'obs-scenes--strip': isStrip }"
  >
    <div class="obs-scenes__title row items-center no-wrap q-pl-sm q-pr-xs">
      <q-icon class="q-mr-sm" color="primary" name="mmm-obs-studio" />
      <div class="col text-weight-medium ellipsis">
        {{ t('obs-scene-window-title') }} · M³
      </div>
      <div class="obs-scenes__connection row items-center no-wrap q-mr-xs">
        <span
          class="obs-scenes__dot q-mr-xs"
          :class="isConnected ? 'bg-positive' : 'bg-negative'"
        />
        {{ connectionLabel }}
      </div>
      <q-btn
        :aria-label="t('obs-collapse-scene-window')"
        class="obs-scenes__no-drag"
        color="primary"
        dense
        flat
        icon="mmm-down"
        round
        size="sm"
        @click="send({ type: 'collapse' })"
      >
        <q-tooltip :delay="500">{{ t('obs-collapse-scene-window') }}</q-tooltip>
      </q-btn>
    </div>

    <div
      v-if="!isConnected"
      class="col column flex-center q-pa-md text-center obs-scenes__no-drag"
    >
      <q-icon color="negative" name="mmm-obs-studio" size="xl" />
      <div class="text-subtitle1 text-weight-medium q-mt-sm">
        {{ t('obs-not-connected') }}
      </div>
      <div class="text-caption q-mb-md">
        {{ t('obs-not-connected-explain') }}
      </div>
      <q-btn
        color="primary"
        icon="mmm-refresh"
        :label="t('obs-reconnect')"
        :loading="state?.connection === 'connecting'"
        no-caps
        unelevated
        @click="send({ type: 'reconnect' })"
      />
    </div>

    <div v-else class="col obs-scenes__body obs-scenes__no-drag">
      <div class="obs-scenes__side">
        <div class="obs-scenes__status">
          <div class="obs-scenes__chip obs-scenes__chip--live">
            <div class="obs-scenes__chip-label row items-center no-wrap">
              <span class="col ellipsis">● {{ t('obs-live') }}</span>
              <span v-if="transitionLabel" class="obs-scenes__tag">
                {{ transitionLabel }}
              </span>
            </div>
            <div class="text-weight-bold ellipsis">{{ liveLabel }}</div>
          </div>
          <div
            class="obs-scenes__chip"
            :class="state?.next ? 'obs-scenes__chip--next' : ''"
          >
            <div class="obs-scenes__chip-label ellipsis">
              {{
                state?.next?.forPrayer
                  ? t('obs-after-song-for-prayer')
                  : t('obs-after-media')
              }}
            </div>
            <div class="text-weight-bold ellipsis">
              {{ state?.next?.label ?? '—' }}
            </div>
          </div>
        </div>
        <div v-if="hint" class="obs-scenes__hint">{{ hint }}</div>
        <div v-if="state?.recording" class="obs-scenes__recording">
          <q-btn
            class="full-width"
            :color="state.recording.active ? 'negative' : 'primary'"
            :icon="state.recording.active ? 'mmm-stop' : 'mmm-record'"
            :label="
              state.recording.active
                ? t('stop-recording')
                : t('start-recording')
            "
            :loading="state.recording.pending"
            no-caps
            unelevated
            @click="send({ type: 'toggle-recording' })"
          />
        </div>
      </div>

      <div class="obs-scenes__grid">
        <q-btn
          v-for="scene in state?.scenes ?? []"
          :key="scene.id"
          class="obs-scenes__scene"
          :class="sceneClass(scene)"
          :color="sceneColor(scene)"
          dense
          no-caps
          :outline="scene.id !== state?.activeSceneId"
          :title="scene.label"
          unelevated
          @click="pickScene(scene)"
        >
          <div class="row items-center no-wrap full-width">
            <q-icon
              v-if="sceneIcon(scene)"
              class="q-mr-xs"
              :name="sceneIcon(scene)"
              size="16px"
            />
            <span class="col ellipsis text-left">{{ scene.label }}</span>
          </div>
          <span v-if="isPrayerScene(scene)" class="obs-scenes__badge">
            {{ t('obs-prayer') }}
          </span>
        </q-btn>
      </div>
    </div>

    <ConfirmDialog
      v-model="confirmOpen"
      :cancel-label="t('obs-keep-stage')"
      confirm-color="warning"
      :confirm-label="t('obs-use-scene', { scene: pendingScene?.label ?? '' })"
      dialog-id="obs-scenes-skip-stage-for-prayer"
      icon="mmm-warning"
      icon-color="warning"
      :message="
        t('obs-skip-stage-for-prayer-explain', {
          scene: pendingScene?.label ?? '',
        })
      "
      :title="t('obs-skip-stage-for-prayer')"
      @cancel="closeConfirm"
      @confirm="confirmPick"
    />
  </q-page>
</template>

<script setup lang="ts">
import type {
  ObsSceneWindowCommand,
  ObsSceneWindowScene,
  ObsSceneWindowState,
} from 'src/types';

import {
  useBroadcastChannel,
  useWindowSize,
  watchImmediate,
} from '@vueuse/core';
import ConfirmDialog from 'components/dialog/ConfirmDialog.vue';
import { useQuasar } from 'quasar';
import {
  OBS_SCENE_WINDOW_COMMAND_CHANNEL,
  OBS_SCENE_WINDOW_STATE_CHANNEL,
} from 'src/composables/useObsSceneWindowBridge';
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';

// M³'s OBS scene window (see window-obs-scenes.ts): shows what the main
// window sends, and sends back what's picked. The main window does the
// scene switching itself, so its rules (no camera over media, Stage for the
// prayer) apply the same here.

// Wider than this many times its height, the window lays out as a strip.
const STRIP_ASPECT_RATIO = 2.4;

const { locale, t } = useI18n();
const $q = useQuasar();

const { data: state } = useBroadcastChannel<
  ObsSceneWindowState,
  ObsSceneWindowState
>({ name: OBS_SCENE_WINDOW_STATE_CHANNEL });

const { post } = useBroadcastChannel<
  ObsSceneWindowCommand,
  ObsSceneWindowCommand
>({ name: OBS_SCENE_WINDOW_COMMAND_CHANNEL });

const send = (command: ObsSceneWindowCommand) => {
  post(command);
};

const { height, width } = useWindowSize();
const isStrip = computed(
  () => height.value > 0 && width.value / height.value > STRIP_ASPECT_RATIO,
);

const isConnected = computed(() => state.value?.connection === 'connected');

const connectionLabel = computed(() =>
  isConnected.value ? t('obsStudio') : t('obs-not-connected-short'),
);

const liveLabel = computed(() => {
  if (state.value?.live) return state.value.live.label;
  const active = state.value?.scenes.find(
    (scene) => scene.id === state.value?.activeSceneId,
  );
  return active?.label ?? '—';
});

const transitionLabel = computed(() => {
  const transition = state.value?.live?.transition;
  if (transition === 'cut') return t('obs-transition-cut');
  if (transition === 'fade') return t('obs-transition-fade');
  return '';
});

const hint = computed(() => {
  const next = state.value?.next;
  if (!next) return '';
  return next.forPrayer
    ? t('obs-next-for-prayer', { scene: next.label })
    : t('obs-next-after-media', { scene: next.label });
});

const isPrayerScene = (scene: ObsSceneWindowScene) =>
  !!state.value?.next?.forPrayer && state.value.next.sceneId === scene.id;

const sceneIcon = (scene: ObsSceneWindowScene) => {
  if (scene.missing) return 'mmm-warning';
  if (state.value?.hideIcons) return undefined;
  if (scene.kind === 'camera') return 'mmm-stage-scene';
  if (scene.kind === 'media') return 'mmm-media-scene';
  if (scene.kind === 'image') return 'mmm-pip-scene';
  return undefined;
};

const sceneColor = (scene: ObsSceneWindowScene) =>
  scene.missing ? 'negative' : 'primary';

const sceneClass = (scene: ObsSceneWindowScene) => ({
  'obs-scenes__scene--next':
    !!state.value?.next && state.value.next.sceneId === scene.id,
});

const confirmOpen = ref(false);
const pendingScene = ref<null | ObsSceneWindowScene>(null);

// Another scene during the meeting's first or last song replaces Stage for
// the prayer: rarely wanted, so ask first.
const pickScene = (scene: ObsSceneWindowScene) => {
  const next = state.value?.next;
  if (next?.forPrayer && scene.id !== next.sceneId) {
    pendingScene.value = scene;
    confirmOpen.value = true;
    return;
  }
  send({ scene: scene.id, type: 'pick' });
};

const closeConfirm = () => {
  confirmOpen.value = false;
  pendingScene.value = null;
};

const confirmPick = () => {
  const scene = pendingScene.value;
  closeConfirm();
  if (scene) send({ scene: scene.id, skipStageForPrayer: true, type: 'pick' });
};

onMounted(() => {
  send({ type: 'ready' });
});

watchImmediate(
  () => state.value?.locale,
  (newLocale) => {
    if (newLocale) locale.value = newLocale;
  },
);

watchImmediate(
  () => state.value?.dark,
  (dark) => {
    if (dark !== undefined) $q.dark.set(dark);
  },
);
</script>

<style scoped lang="scss">
.obs-scenes {
  background: white;
  height: 100vh;
  font-size: 13px;
}

:global(body.body--dark .obs-scenes) {
  background: $dark-page;
}

.obs-scenes__title {
  -webkit-app-region: drag;
  border-bottom: 1px solid rgba($primary, 0.2);
  background: rgba($primary, 0.06);
  flex: none;
  height: 36px;
}

.obs-scenes__no-drag,
.obs-scenes__title .q-btn {
  -webkit-app-region: no-drag;
}

.obs-scenes__connection {
  font-size: 11px;
  opacity: 0.75;
}

.obs-scenes__dot {
  border-radius: 50%;
  display: inline-block;
  height: 8px;
  width: 8px;
}

.obs-scenes__body {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

// Tall: status on top, scenes, then recording at the bottom.
.obs-scenes__side {
  display: contents;
}

.obs-scenes__status {
  display: flex;
  gap: 6px;
  padding: 8px 10px 4px;
}

.obs-scenes__chip {
  background: rgba($primary, 0.06);
  border-radius: 8px;
  flex: 1;
  font-size: 11px;
  line-height: 1.3;
  min-width: 0;
  padding: 6px 8px;

  .text-weight-bold {
    font-size: 13px;
  }
}

.obs-scenes__chip-label {
  opacity: 0.8;
}

.obs-scenes__chip--live {
  background: rgba($negative, 0.1);

  .obs-scenes__chip-label {
    color: $negative;
    opacity: 1;
  }
}

.obs-scenes__chip--next {
  background: rgba($warning, 0.14);
}

.obs-scenes__tag {
  background: rgba($negative, 0.15);
  border-radius: 3px;
  font-size: 10px;
  font-weight: 700;
  padding: 0 4px;
  text-transform: uppercase;
}

.obs-scenes__hint {
  color: darken($warning, 15%);
  font-size: 11px;
  padding: 2px 12px 4px;
}

.obs-scenes__recording {
  border-top: 1px solid rgba($primary, 0.2);
  order: 2;
  padding: 8px 10px 10px;
}

.obs-scenes__grid {
  align-content: start;
  display: grid;
  flex: 1;
  gap: 8px 5px;
  grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
  min-height: 0;
  order: 1;
  overflow-y: auto;
  padding: 8px 10px 10px;
}

.obs-scenes__scene {
  font-size: 12px;
  font-weight: 600;
  min-width: 0;
  position: relative;
}

.obs-scenes__scene--next {
  outline: 2px dashed $warning;
  outline-offset: 1px;
}

.obs-scenes__badge {
  background: $warning;
  border-radius: 3px;
  color: white;
  font-size: 9px;
  font-weight: 700;
  padding: 1px 4px;
  position: absolute;
  right: 6px;
  text-transform: uppercase;
  top: -9px;
}

// Wide and short: status and recording on the left, scenes on the right.
.obs-scenes--strip {
  .obs-scenes__body {
    flex-direction: row;
  }

  .obs-scenes__side {
    border-right: 1px solid rgba($primary, 0.2);
    display: flex;
    flex: none;
    flex-direction: column;
    width: 200px;
  }

  .obs-scenes__status {
    flex-direction: column;
  }

  .obs-scenes__recording {
    border-top: none;
    margin-top: auto;
  }
}
</style>
