import { getProviderDisplayName } from '@remote-agent-server/providers'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { MobileOperatorController } from './controller.js'

interface MobileOperatorAppProps {
  controller: MobileOperatorController
}

function formatTimestamp(value?: string) {
  if (!value) {
    return 'Awaiting update'
  }

  return new Date(value).toLocaleString()
}

function getStateTone(state: string) {
  if (state === 'running' || state === 'completed') {
    return styles.stateToneGood
  }

  if (state === 'blocked' || state === 'paused') {
    return styles.stateToneAttention
  }

  if (state === 'failed' || state === 'canceled' || state === 'rejected') {
    return styles.stateToneDanger
  }

  return styles.stateToneMuted
}

export function MobileOperatorApp({ controller }: MobileOperatorAppProps) {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  )
  const [baseUrl, setBaseUrl] = useState('')
  const [token, setToken] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const seededDrafts = useRef(false)

  useEffect(() => {
    void controller.bootstrap()

    return () => {
      controller.destroy()
    }
  }, [controller])

  useEffect(() => {
    if (seededDrafts.current || !state.connection) {
      return
    }

    seededDrafts.current = true
    setBaseUrl(state.connection.baseUrl)
    setToken(state.connection.token)
  }, [state.connection])

  async function handleConnect() {
    try {
      await controller.connect({
        baseUrl,
        token,
      })
    } catch (error) {
      Alert.alert(
        'Connection failed',
        error instanceof Error ? error.message : 'Connection failed.',
      )
    }
  }

  async function handleRefresh() {
    setRefreshing(true)
    try {
      await controller.refresh()
    } catch (error) {
      Alert.alert(
        'Refresh failed',
        error instanceof Error ? error.message : 'Refresh failed.',
      )
    } finally {
      setRefreshing(false)
    }
  }

  async function handleApprovalDecision(
    approvalId: string,
    status: 'approved' | 'rejected',
  ) {
    try {
      await controller.decideApproval(approvalId, status)
    } catch (error) {
      Alert.alert(
        'Approval update failed',
        error instanceof Error ? error.message : 'Approval update failed.',
      )
    }
  }

  async function handlePreviewOpen(
    portId: string,
    mode: 'in-app' | 'browser',
  ) {
    try {
      await controller.openPreview(portId, mode)
    } catch (error) {
      Alert.alert(
        'Preview failed',
        error instanceof Error ? error.message : 'Preview failed to open.',
      )
    }
  }

  async function handleForgetConnection() {
    try {
      await controller.forgetConnection()
      setToken('')
    } catch (error) {
      Alert.alert(
        'Clear saved connection failed',
        error instanceof Error
          ? error.message
          : 'Clear saved connection failed.',
      )
    }
  }

  const pendingApprovals = state.dashboard.approvals.filter(
    (approval) => approval.status === 'pending',
  )

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        refreshControl={
          state.phase === 'ready'
            ? (
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={handleRefresh}
                  tintColor="#fb923c"
                />
              )
            : undefined
        }
      >
        <View style={styles.heroCard}>
          <Text style={styles.eyebrow}>Remote Agent Server</Text>
          <Text style={styles.heroTitle}>Phone console for live operator work</Text>
          <Text style={styles.heroBody}>
            Review active hosts, watch sessions move in real time, decide approvals, and open shared previews from Expo.
          </Text>
          <View style={styles.heroMetaRow}>
            <View style={styles.metricTile}>
              <Text style={styles.metricLabel}>Hosts</Text>
              <Text style={styles.metricValue}>{state.dashboard.hosts.length}</Text>
            </View>
            <View style={styles.metricTile}>
              <Text style={styles.metricLabel}>Sessions</Text>
              <Text style={styles.metricValue}>{state.dashboard.sessions.length}</Text>
            </View>
            <View style={styles.metricTile}>
              <Text style={styles.metricLabel}>Approvals</Text>
              <Text style={styles.metricValue}>{pendingApprovals.length}</Text>
            </View>
          </View>
        </View>

        <View style={styles.surfaceCard}>
          <Text style={styles.sectionTitle}>Connection</Text>
          <Text style={styles.supportText}>
            Save a control-plane base URL and operator token in Expo SecureStore for this self-hosted setup.
          </Text>
          <TextInput
            value={baseUrl}
            onChangeText={setBaseUrl}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="http://192.168.1.15:4318"
            placeholderTextColor="#8f7d6f"
            style={styles.input}
          />
          <TextInput
            value={token}
            onChangeText={setToken}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            placeholder="operator-secret"
            placeholderTextColor="#8f7d6f"
            style={styles.input}
          />
          <View style={styles.row}>
            <Pressable
              onPress={() => {
                void handleConnect()
              }}
              style={[styles.button, styles.primaryButton]}
            >
              <Text style={styles.primaryButtonLabel}>
                {state.phase === 'connecting' ? 'Connecting…' : 'Connect'}
              </Text>
            </Pressable>
            {state.connection
              ? (
                  <Pressable
                    onPress={() => {
                      void handleForgetConnection()
                    }}
                    style={[styles.button, styles.secondaryButton]}
                  >
                    <Text style={styles.secondaryButtonLabel}>Forget</Text>
                  </Pressable>
                )
              : null}
          </View>
          <View style={styles.connectionBar}>
            <Text style={styles.connectionLabel}>Live link</Text>
            <Text style={[styles.connectionPill, getStateTone(state.liveConnection)]}>
              {state.liveConnection}
            </Text>
          </View>
          {state.lastEventType
            ? <Text style={styles.supportText}>Last event: {state.lastEventType}</Text>
            : null}
          {state.error ? <Text style={styles.errorText}>{state.error}</Text> : null}
        </View>

        {state.phase !== 'ready'
          ? (
              <View style={styles.loadingCard}>
                {state.phase === 'booting' || state.phase === 'connecting'
                  ? <ActivityIndicator color="#fb923c" />
                  : null}
                <Text style={styles.loadingText}>
                  {state.phase === 'booting'
                    ? 'Checking for saved mobile credentials…'
                    : state.phase === 'connecting'
                      ? 'Negotiating with the control plane…'
                      : 'Connect to browse hosts, sessions, approvals, and previews.'}
                </Text>
              </View>
            )
          : (
              <>
                <View style={styles.surfaceCard}>
                  <Text style={styles.sectionTitle}>Pending approvals</Text>
                  {pendingApprovals.length === 0
                    ? <Text style={styles.supportText}>No actions are waiting on you.</Text>
                    : pendingApprovals.map((approval) => (
                        <View key={approval.id} style={styles.listCard}>
                          <Text style={styles.cardTitle}>
                            {getProviderDisplayName(approval.provider)}
                          </Text>
                          <Text style={styles.cardBody}>{approval.message}</Text>
                          <Text style={styles.metaLine}>
                            {approval.action} • {approval.sessionId}
                          </Text>
                          <View style={styles.row}>
                            <Pressable
                              onPress={() => {
                                void handleApprovalDecision(approval.id, 'approved')
                              }}
                              disabled={state.busyApprovalId === approval.id}
                              style={[styles.button, styles.primaryButton]}
                            >
                              <Text style={styles.primaryButtonLabel}>Approve</Text>
                            </Pressable>
                            <Pressable
                              onPress={() => {
                                void handleApprovalDecision(approval.id, 'rejected')
                              }}
                              disabled={state.busyApprovalId === approval.id}
                              style={[styles.button, styles.rejectButton]}
                            >
                              <Text style={styles.rejectButtonLabel}>Reject</Text>
                            </Pressable>
                          </View>
                        </View>
                      ))}
                </View>

                <View style={styles.surfaceCard}>
                  <Text style={styles.sectionTitle}>Forwarded previews</Text>
                  {state.dashboard.forwardedPorts.length === 0
                    ? (
                        <Text style={styles.supportText}>
                          No shared HTTP previews are active. Open forwarded ports from the control plane first.
                        </Text>
                      )
                    : state.dashboard.forwardedPorts.map((port) => (
                        <View key={port.id} style={styles.listCard}>
                          <View style={styles.spaceBetweenRow}>
                            <Text style={styles.cardTitle}>{port.label}</Text>
                            <Text style={[styles.connectionPill, getStateTone(port.forwardingState ?? 'open')]}>
                              {port.forwardingState ?? 'open'}
                            </Text>
                          </View>
                          <Text style={styles.cardBody}>
                            {port.targetHost}:{port.port} • {port.visibility}
                          </Text>
                          <Text style={styles.metaLine}>Managed URL: {port.managedUrl}</Text>
                          <View style={styles.row}>
                            <Pressable
                              onPress={() => {
                                void handlePreviewOpen(port.id, 'in-app')
                              }}
                              style={[styles.button, styles.primaryButton]}
                            >
                              <Text style={styles.primaryButtonLabel}>In app</Text>
                            </Pressable>
                            <Pressable
                              onPress={() => {
                                void handlePreviewOpen(port.id, 'browser')
                              }}
                              style={[styles.button, styles.secondaryButton]}
                            >
                              <Text style={styles.secondaryButtonLabel}>Browser</Text>
                            </Pressable>
                          </View>
                        </View>
                      ))}
                </View>

                <View style={styles.surfaceCard}>
                  <Text style={styles.sectionTitle}>Live sessions</Text>
                  {state.dashboard.sessions.length === 0
                    ? <Text style={styles.supportText}>No sessions are visible right now.</Text>
                    : state.dashboard.sessions.map((session) => (
                        <View key={session.id} style={styles.listCard}>
                          <View style={styles.spaceBetweenRow}>
                            <Text style={styles.cardTitle}>{session.id}</Text>
                            <Text style={[styles.connectionPill, getStateTone(session.state)]}>
                              {session.state}
                            </Text>
                          </View>
                          <Text style={styles.cardBody}>
                            {getProviderDisplayName(session.provider as 'claude-code' | 'codex' | 'opencode')}
                          </Text>
                          <Text style={styles.metaLine}>Workspace: {session.workspacePath}</Text>
                          <Text style={styles.metaLine}>Updated: {formatTimestamp(session.updatedAt)}</Text>
                          {session.logs.at(-1)
                            ? (
                                <View style={styles.logStrip}>
                                  <Text style={styles.logStripLabel}>Last log</Text>
                                  <Text style={styles.logStripText}>{session.logs.at(-1)?.message}</Text>
                                </View>
                              )
                            : null}
                        </View>
                      ))}
                </View>

                <View style={styles.surfaceCard}>
                  <Text style={styles.sectionTitle}>Hosts</Text>
                  {state.dashboard.hosts.length === 0
                    ? <Text style={styles.supportText}>No hosts are registered.</Text>
                    : state.dashboard.hosts.map((host) => (
                        <View key={host.id} style={styles.listCard}>
                          <View style={styles.spaceBetweenRow}>
                            <Text style={styles.cardTitle}>{host.name}</Text>
                            <Text style={[styles.connectionPill, getStateTone(host.status)]}>
                              {host.status}
                            </Text>
                          </View>
                          <Text style={styles.cardBody}>
                            {host.platform} • runtime {host.runtimeVersion}
                          </Text>
                          <Text style={styles.metaLine}>
                            {host.health} • {host.connectivity}
                          </Text>
                          <Text style={styles.metaLine}>
                            Last seen {formatTimestamp(host.lastSeenAt)}
                          </Text>
                        </View>
                      ))}
                </View>
              </>
            )}
      </ScrollView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#efe2cf',
  },
  scrollView: {
    flex: 1,
  },
  content: {
    gap: 18,
    paddingHorizontal: 18,
    paddingVertical: 22,
  },
  heroCard: {
    backgroundColor: '#241b17',
    borderRadius: 28,
    padding: 22,
    gap: 10,
    shadowColor: '#140f0d',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.18,
    shadowRadius: 24,
  },
  eyebrow: {
    color: '#f6d4b0',
    fontFamily: 'Courier',
    fontSize: 12,
    letterSpacing: 2.4,
    textTransform: 'uppercase',
  },
  heroTitle: {
    color: '#fff7ed',
    fontSize: 30,
    fontWeight: '700',
    lineHeight: 34,
  },
  heroBody: {
    color: '#dbc0a6',
    fontSize: 15,
    lineHeight: 21,
  },
  heroMetaRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 8,
  },
  metricTile: {
    flex: 1,
    backgroundColor: '#3a2a24',
    borderRadius: 18,
    padding: 12,
    gap: 4,
  },
  metricLabel: {
    color: '#dbc0a6',
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 1.2,
  },
  metricValue: {
    color: '#fff7ed',
    fontSize: 22,
    fontWeight: '700',
  },
  surfaceCard: {
    backgroundColor: '#fff8ef',
    borderRadius: 24,
    padding: 18,
    gap: 12,
    borderWidth: 1,
    borderColor: '#dec6ae',
  },
  sectionTitle: {
    color: '#221712',
    fontSize: 21,
    fontWeight: '700',
  },
  supportText: {
    color: '#6b4d3c',
    fontSize: 14,
    lineHeight: 20,
  },
  input: {
    backgroundColor: '#f1e3d2',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#dec6ae',
    color: '#221712',
    fontSize: 15,
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
  row: {
    flexDirection: 'row',
    gap: 10,
  },
  button: {
    alignItems: 'center',
    borderRadius: 999,
    justifyContent: 'center',
    minHeight: 46,
    paddingHorizontal: 18,
  },
  primaryButton: {
    backgroundColor: '#fb923c',
    flex: 1,
  },
  primaryButtonLabel: {
    color: '#221712',
    fontSize: 15,
    fontWeight: '700',
  },
  secondaryButton: {
    backgroundColor: '#efe2cf',
    borderColor: '#dec6ae',
    borderWidth: 1,
    flex: 1,
  },
  secondaryButtonLabel: {
    color: '#4f3427',
    fontSize: 15,
    fontWeight: '700',
  },
  rejectButton: {
    backgroundColor: '#311c1a',
    flex: 1,
  },
  rejectButtonLabel: {
    color: '#fff1ed',
    fontSize: 15,
    fontWeight: '700',
  },
  connectionBar: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  connectionLabel: {
    color: '#4f3427',
    fontFamily: 'Courier',
    fontSize: 12,
    letterSpacing: 1.8,
    textTransform: 'uppercase',
  },
  connectionPill: {
    borderRadius: 999,
    overflow: 'hidden',
    paddingHorizontal: 10,
    paddingVertical: 6,
    textTransform: 'uppercase',
  },
  stateToneGood: {
    backgroundColor: '#d9f99d',
    color: '#365314',
  },
  stateToneAttention: {
    backgroundColor: '#fed7aa',
    color: '#9a3412',
  },
  stateToneDanger: {
    backgroundColor: '#fecaca',
    color: '#991b1b',
  },
  stateToneMuted: {
    backgroundColor: '#e7d8c8',
    color: '#5b463b',
  },
  errorText: {
    color: '#b91c1c',
    fontSize: 14,
    fontWeight: '600',
  },
  loadingCard: {
    alignItems: 'center',
    backgroundColor: '#fff8ef',
    borderColor: '#dec6ae',
    borderRadius: 24,
    borderWidth: 1,
    gap: 12,
    padding: 28,
  },
  loadingText: {
    color: '#6b4d3c',
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  listCard: {
    backgroundColor: '#f6ede2',
    borderRadius: 20,
    gap: 8,
    padding: 16,
  },
  cardTitle: {
    color: '#221712',
    fontSize: 17,
    fontWeight: '700',
  },
  cardBody: {
    color: '#4f3427',
    fontSize: 14,
    lineHeight: 20,
  },
  metaLine: {
    color: '#7b5a49',
    fontFamily: 'Courier',
    fontSize: 12,
    lineHeight: 18,
  },
  spaceBetweenRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'space-between',
  },
  logStrip: {
    backgroundColor: '#231f20',
    borderRadius: 16,
    gap: 6,
    padding: 12,
  },
  logStripLabel: {
    color: '#f6d4b0',
    fontFamily: 'Courier',
    fontSize: 11,
    letterSpacing: 1.8,
    textTransform: 'uppercase',
  },
  logStripText: {
    color: '#fff7ed',
    fontSize: 13,
    lineHeight: 18,
  },
})
