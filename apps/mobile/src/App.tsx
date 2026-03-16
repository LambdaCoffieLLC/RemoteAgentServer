import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import type { SessionEvent } from '@remote-agent/sessions'
import { createExpoPreviewOpeners } from './expo-preview.js'
import {
  applyMobileControlPlaneEvent,
  buildMobileBrowseItems,
  createMobileControlPlaneClient,
  resolveForwardedPreviewUrl,
  type MobileBrowseTarget,
  type MobileClientDashboard,
} from './index.js'

const defaultBaseUrl = 'http://127.0.0.1:3000'
const defaultToken = 'control-plane-operator'

export default function App() {
  const [baseUrl, setBaseUrl] = useState(defaultBaseUrl)
  const [token, setToken] = useState(defaultToken)
  const [connection, setConnection] = useState<{ baseUrl: string; token: string }>()
  const [dashboard, setDashboard] = useState<MobileClientDashboard>()
  const [browseTarget, setBrowseTarget] = useState<MobileBrowseTarget>('sessions')
  const [selectedSessionId, setSelectedSessionId] = useState<string>()
  const [sessionEvents, setSessionEvents] = useState<Record<string, SessionEvent[]>>({})
  const [isLoading, setIsLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string>()

  useEffect(() => {
    if (!connection) {
      return
    }

    const client = createMobileControlPlaneClient({
      ...connection,
      previewOpeners: createExpoPreviewOpeners(),
    })
    const abortController = new AbortController()

    void (async () => {
      try {
        for await (const event of client.streamEvents({ signal: abortController.signal })) {
          setDashboard((current) => applyMobileControlPlaneEvent(current, event))

          if (event.type === 'control-plane.snapshot') {
            setSessionEvents({})
            continue
          }

          if (event.type === 'session.event.created') {
            const sessionEvent = (event.payload as { sessionEvent?: SessionEvent }).sessionEvent

            if (sessionEvent) {
              setSessionEvents((current) => ({
                ...current,
                [sessionEvent.sessionId]: [...(current[sessionEvent.sessionId] ?? []), sessionEvent].slice(-20),
              }))
            }
          }
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          return
        }

        setErrorMessage(error instanceof Error ? error.message : 'The mobile event stream disconnected unexpectedly.')
      }
    })()

    return () => {
      abortController.abort()
    }
  }, [connection])

  const browseItems = dashboard ? buildMobileBrowseItems(dashboard, browseTarget) : []
  const selectedSessionEvents = selectedSessionId ? sessionEvents[selectedSessionId] ?? [] : []

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <Text style={styles.eyebrow}>Remote Agent Mobile</Text>
        <Text style={styles.title}>Monitor sessions, approvals, and previews from Expo.</Text>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Connect</Text>
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={setBaseUrl}
            placeholder="http://127.0.0.1:3000"
            style={styles.input}
            value={baseUrl}
          />
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={setToken}
            placeholder="control-plane-operator"
            secureTextEntry
            style={styles.input}
            value={token}
          />
          <Pressable onPress={() => void handleSignIn(baseUrl, token, setConnection, setDashboard, setIsLoading, setErrorMessage)}>
            <View style={[styles.button, styles.primaryButton]}>
              {isLoading ? <ActivityIndicator color="#08111b" /> : <Text style={styles.primaryButtonLabel}>Sign in</Text>}
            </View>
          </Pressable>
          <Text style={styles.helperText}>
            {connection ? `Connected to ${connection.baseUrl}` : 'Enter a server URL and bearer token.'}
          </Text>
          {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Browse</Text>
          <View style={styles.segmentRow}>
            <SegmentButton
              active={browseTarget === 'sessions'}
              label="Sessions"
              onPress={() => setBrowseTarget('sessions')}
            />
            <SegmentButton active={browseTarget === 'hosts'} label="Hosts" onPress={() => setBrowseTarget('hosts')} />
          </View>
          {browseItems.length === 0 ? (
            <Text style={styles.helperText}>Sign in to load hosts and sessions.</Text>
          ) : (
            browseItems.map((item) => (
              <Pressable
                key={item.id}
                onPress={() => {
                  if (browseTarget === 'sessions') {
                    setSelectedSessionId(item.id)
                  }
                }}
              >
                <View style={styles.listItem}>
                  <View style={styles.listItemText}>
                    <Text style={styles.listTitle}>{item.title}</Text>
                    <Text style={styles.listSubtitle}>{item.subtitle}</Text>
                    <Text style={styles.listDetail}>{item.detail}</Text>
                  </View>
                  <Text style={styles.badge}>{item.badge}</Text>
                </View>
              </Pressable>
            ))
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Pending approvals</Text>
          {!dashboard || dashboard.approvals.length === 0 ? (
            <Text style={styles.helperText}>No approvals waiting.</Text>
          ) : (
            dashboard.approvals.map((approval) => (
              <View key={approval.id} style={styles.listItem}>
                <View style={styles.listItemText}>
                  <Text style={styles.listTitle}>{approval.action}</Text>
                  <Text style={styles.listSubtitle}>{approval.sessionId}</Text>
                  <Text style={styles.listDetail}>{approval.status}</Text>
                </View>
                <View style={styles.inlineActions}>
                  <SmallActionButton
                    label="Approve"
                    onPress={() =>
                      void handleApprovalDecision(connection, approval.id, 'approved', setDashboard, setErrorMessage)
                    }
                  />
                  <SmallActionButton
                    label="Reject"
                    onPress={() =>
                      void handleApprovalDecision(connection, approval.id, 'rejected', setDashboard, setErrorMessage)
                    }
                  />
                </View>
              </View>
            ))
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Forwarded previews</Text>
          {!dashboard ? (
            <Text style={styles.helperText}>Sign in to view active forwarded ports.</Text>
          ) : (
            dashboard.ports
              .filter((port) => resolveForwardedPreviewUrl(port))
              .map((port) => (
                <View key={port.id} style={styles.listItem}>
                  <View style={styles.listItemText}>
                    <Text style={styles.listTitle}>{port.label}</Text>
                    <Text style={styles.listSubtitle}>{port.id}</Text>
                    <Text style={styles.listDetail}>{resolveForwardedPreviewUrl(port)}</Text>
                  </View>
                  <View style={styles.inlineActions}>
                    <SmallActionButton
                      label="In-app"
                      onPress={() => void handlePreviewOpen(connection, port, 'in-app', setErrorMessage)}
                    />
                    <SmallActionButton
                      label="Browser"
                      onPress={() => void handlePreviewOpen(connection, port, 'system', setErrorMessage)}
                    />
                  </View>
                </View>
              ))
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Live session feed</Text>
          {!selectedSessionId ? (
            <Text style={styles.helperText}>Select a session above to watch live updates.</Text>
          ) : selectedSessionEvents.length === 0 ? (
            <Text style={styles.helperText}>Waiting for new events from {selectedSessionId}.</Text>
          ) : (
            selectedSessionEvents
              .slice()
              .reverse()
              .map((event) => (
                <View key={event.id} style={styles.feedItem}>
                  <Text style={styles.feedTitle}>{event.kind}</Text>
                  <Text style={styles.listSubtitle}>{event.message}</Text>
                </View>
              ))
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}

interface SegmentButtonProps {
  active: boolean
  label: string
  onPress: () => void
}

function SegmentButton(props: SegmentButtonProps) {
  return (
    <Pressable onPress={props.onPress}>
      <View style={[styles.segmentButton, props.active ? styles.segmentButtonActive : undefined]}>
        <Text style={props.active ? styles.segmentButtonLabelActive : styles.segmentButtonLabel}>{props.label}</Text>
      </View>
    </Pressable>
  )
}

interface SmallActionButtonProps {
  label: string
  onPress: () => void
}

function SmallActionButton(props: SmallActionButtonProps) {
  return (
    <Pressable onPress={props.onPress}>
      <View style={styles.smallButton}>
        <Text style={styles.smallButtonLabel}>{props.label}</Text>
      </View>
    </Pressable>
  )
}

async function handleSignIn(
  baseUrl: string,
  token: string,
  setConnection: Dispatch<SetStateAction<{ baseUrl: string; token: string } | undefined>>,
  setDashboard: Dispatch<SetStateAction<MobileClientDashboard | undefined>>,
  setIsLoading: Dispatch<SetStateAction<boolean>>,
  setErrorMessage: Dispatch<SetStateAction<string | undefined>>,
) {
  setIsLoading(true)
  setErrorMessage(undefined)

  try {
    const client = createMobileControlPlaneClient({
      baseUrl,
      token,
      previewOpeners: createExpoPreviewOpeners(),
    })
    const nextDashboard = await client.signIn()
    setConnection({ baseUrl, token })
    setDashboard(nextDashboard)
  } catch (error) {
    setErrorMessage(error instanceof Error ? error.message : 'The mobile app could not sign in.')
  } finally {
    setIsLoading(false)
  }
}

async function handleApprovalDecision(
  connection: { baseUrl: string; token: string } | undefined,
  approvalId: string,
  status: 'approved' | 'rejected',
  setDashboard: Dispatch<SetStateAction<MobileClientDashboard | undefined>>,
  setErrorMessage: Dispatch<SetStateAction<string | undefined>>,
) {
  if (!connection) {
    setErrorMessage('Connect the mobile app before deciding an approval.')
    return
  }

  try {
    const client = createMobileControlPlaneClient({
      ...connection,
      previewOpeners: createExpoPreviewOpeners(),
    })
    const updatedApproval = await client.decideApproval(approvalId as never, status)
    setDashboard((current) =>
      current
        ? {
            ...current,
            approvals: current.approvals.map((approval) => (approval.id === updatedApproval.id ? updatedApproval : approval)),
          }
        : current,
    )
  } catch (error) {
    setErrorMessage(error instanceof Error ? error.message : 'The approval decision failed.')
  }
}

async function handlePreviewOpen(
  connection: { baseUrl: string; token: string } | undefined,
  port: MobileClientDashboard['ports'][number],
  mode: 'in-app' | 'system',
  setErrorMessage: Dispatch<SetStateAction<string | undefined>>,
) {
  if (!connection) {
    setErrorMessage('Connect the mobile app before opening a forwarded preview.')
    return
  }

  try {
    const client = createMobileControlPlaneClient({
      ...connection,
      previewOpeners: createExpoPreviewOpeners(),
    })
    await client.openForwardedPreview(port, { mode })
  } catch (error) {
    setErrorMessage(error instanceof Error ? error.message : 'The forwarded preview could not be opened.')
  }
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#f5efe2',
  },
  screen: {
    flex: 1,
    backgroundColor: '#f5efe2',
  },
  content: {
    paddingHorizontal: 20,
    paddingVertical: 24,
    gap: 16,
  },
  eyebrow: {
    fontSize: 12,
    letterSpacing: 2,
    textTransform: 'uppercase',
    color: '#805b2c',
    fontWeight: '700',
  },
  title: {
    fontSize: 28,
    lineHeight: 34,
    color: '#1c2731',
    fontWeight: '700',
  },
  card: {
    backgroundColor: '#fffaf0',
    borderRadius: 20,
    padding: 18,
    gap: 12,
    borderWidth: 1,
    borderColor: '#d9c4a4',
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1c2731',
  },
  input: {
    borderWidth: 1,
    borderColor: '#d9c4a4',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: '#fff',
    color: '#1c2731',
  },
  button: {
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: 18,
  },
  primaryButton: {
    backgroundColor: '#ffb347',
  },
  primaryButtonLabel: {
    color: '#08111b',
    fontSize: 16,
    fontWeight: '700',
  },
  helperText: {
    color: '#5f6d78',
    fontSize: 14,
  },
  errorText: {
    color: '#a22d2d',
    fontSize: 14,
  },
  segmentRow: {
    flexDirection: 'row',
    gap: 10,
  },
  segmentButton: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#d9c4a4',
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: '#fff',
  },
  segmentButtonActive: {
    backgroundColor: '#1c2731',
    borderColor: '#1c2731',
  },
  segmentButtonLabel: {
    color: '#1c2731',
    fontWeight: '600',
  },
  segmentButtonLabelActive: {
    color: '#fffaf0',
    fontWeight: '700',
  },
  listItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 6,
  },
  listItemText: {
    flex: 1,
    gap: 2,
  },
  listTitle: {
    color: '#1c2731',
    fontWeight: '700',
    fontSize: 15,
  },
  listSubtitle: {
    color: '#5f6d78',
    fontSize: 13,
  },
  listDetail: {
    color: '#805b2c',
    fontSize: 12,
  },
  badge: {
    alignSelf: 'flex-start',
    backgroundColor: '#f2dfbf',
    color: '#805b2c',
    borderRadius: 999,
    overflow: 'hidden',
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 12,
    fontWeight: '700',
  },
  inlineActions: {
    alignItems: 'flex-end',
    gap: 8,
  },
  smallButton: {
    minWidth: 82,
    borderRadius: 999,
    backgroundColor: '#1c2731',
    paddingHorizontal: 12,
    paddingVertical: 10,
    alignItems: 'center',
  },
  smallButtonLabel: {
    color: '#fffaf0',
    fontWeight: '700',
    fontSize: 12,
  },
  feedItem: {
    borderTopWidth: 1,
    borderTopColor: '#ead8bb',
    paddingTop: 10,
    gap: 2,
  },
  feedTitle: {
    color: '#1c2731',
    fontWeight: '700',
    fontSize: 13,
  },
})
