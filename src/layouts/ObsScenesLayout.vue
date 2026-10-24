<template>
  <q-layout class="obs-scenes-layout" view="hHh lpR fFf">
    <q-page-container>
      <!-- This is where pages get injected -->
      <router-view />
    </q-page-container>
  </q-layout>
</template>

<script setup lang="ts">
import { useMeta, useQuasar } from 'quasar';
import { initializeElectronApi } from 'src/helpers/electron-api-manager';
import { mmmIconMapFn } from 'src/utils/icon-map';

void initializeElectronApi('ObsScenesLayout');

// Each window installs M³'s icon font mapping itself.
const $q = useQuasar();
$q.iconMapFn = mmmIconMapFn;

useMeta({
  title: 'Scenes',
  titleTemplate: (title) => `${title} - M³`,
});
</script>
