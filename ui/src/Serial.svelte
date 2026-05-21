<script lang="ts">
  import Card from './lib/Card.svelte'
  import { address, connectionStatus } from 'api/src/vars'
  import { hasAccess } from './lib/util'
  import axios from 'axios'

  let serialPorts: { path: string; manufacturer?: string }[] = []

  async function refreshPorts() {
    try {
      let res = await axios.get('/serialPorts')
      serialPorts = res.data
    } catch (e) {
      serialPorts = []
    }
  }

  $: if ($connectionStatus == 'disconnected') refreshPorts()
</script>

{#if $connectionStatus == 'disconnected' && $hasAccess}
  <Card title="Serial Devices" {...$$restProps}>
    <div class="text-sm p-2 flex flex-col gap-1">
      {#if serialPorts.length == 0}
        <p>No serial devices detected</p>
      {/if}
      {#each serialPorts as port}
        <button
          class="btn"
          on:click={() => {
            $address = port.path
            axios.post('/connect', { address: port.path })
          }}
        >
          {port.path} {port.manufacturer ? `(${port.manufacturer})` : ''}
        </button>
      {/each}
      <button class="btn text-xs opacity-70" on:click={refreshPorts}>↻ Refresh</button>
    </div>
  </Card>
{/if}
