import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  Platform,
  ScrollView,
  StyleSheet,
  View,
  Text,
  TextInput,
  Button,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import * as Location from 'expo-location';
import * as FileSystem from 'expo-file-system/legacy'; 
import * as Device from 'expo-device';
// Buffer and sha256 removed to avoid reading large files into JS memory

// --- CONFIGURATION ---
// VERIFY YOUR IP ADDRESS!
const DEFAULT_SERVER_URL = "YOUR ADDEDRESS_HERE"; // e.g., "http://
// ---------------------

// No global Buffer required — avoid referencing `Buffer` in Expo managed app

// --- TYPES & CONTEXT ---
interface UserProfile { id: string; email: string; name?: string | null; role: string; }
interface AuthState { token: string | null; serverUrl: string; user?: UserProfile; deviceId?: string; }
interface AuthContextValue extends AuthState { setAuth: (state: AuthState) => void; }

const AuthContext = createContext<AuthContextValue>({ token: null, serverUrl: '', setAuth: () => undefined });
const Stack = createNativeStackNavigator();
const useAuth = () => useContext(AuthContext);

// --- API HELPER ---
const API = {
  async request(path: string, options: RequestInit = {}, auth: AuthState): Promise<Response> {
    if (!auth.serverUrl) throw new Error('Server URL not configured');
    const baseHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
    if (auth.token) baseHeaders.Authorization = `Bearer ${auth.token}`;
    
    const res = await fetch(`${auth.serverUrl}${path}`, {
      ...options,
      headers: { ...baseHeaders, ...(options.headers as Record<string, string> | undefined) },
    });
    
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Request failed (${res.status}): ${detail}`);
    }
    return res;
  },
};

// --- SCREENS ---

const LoginScreen: React.FC<any> = ({ navigation }) => {
  const auth = useAuth();
  const [serverUrl, setServerUrl] = useState(auth.serverUrl || DEFAULT_SERVER_URL);
  const [email, setEmail] = useState('rider@example.com');
  const [password, setPassword] = useState('changeme');
  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');

  const handleLogin = async () => {
    try {
      setLoading(true);
      setStatusMsg('Connecting...');
      const normalizedServer = serverUrl.replace(/\/$/, '');
      
      const response = await API.request('/auth/token', {
          method: 'POST',
          body: JSON.stringify({ email, password, name: email.split('@')[0] }),
      }, { ...auth, serverUrl: normalizedServer });
      
      const tokenPayload = await response.json();
      
      const profileResponse = await API.request('/me', {}, { ...auth, serverUrl: normalizedServer, token: tokenPayload.access_token });
      const profile = await profileResponse.json();
      
      auth.setAuth({
        serverUrl: normalizedServer,
        token: tokenPayload.access_token,
        user: profile,
      });
      
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.header}>Bike Recorder</Text>
        <Text style={styles.label}>Server URL</Text>
        <TextInput style={styles.input} value={serverUrl} onChangeText={setServerUrl} autoCapitalize="none" />
        <Text style={styles.label}>Email</Text>
        <TextInput style={styles.input} value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />
        <Text style={styles.label}>Password</Text>
        <TextInput style={styles.input} value={password} onChangeText={setPassword} secureTextEntry />
        <View style={styles.spacer} />
        <Button title={loading ? "Logging in..." : "Sign In"} onPress={handleLogin} disabled={loading} />
        {!!statusMsg && <Text style={styles.errorText}>{statusMsg}</Text>}
      </View>
    </SafeAreaView>
  );
};

const RecorderScreen: React.FC<any> = ({ navigation }) => {
  const auth = useAuth();
  const cameraRef = useRef<CameraView | null>(null);
  
  const [camPermission, requestCamPermission] = useCameraPermissions();
  const [micPermission, requestMicPermission] = useMicrophonePermissions();
  
  const [isRecording, setIsRecording] = useState(false);
  const [statusMsg, setStatusMsg] = useState('Ready');
  const [timer, setTimer] = useState(0);
  
  // --- FIX: Use Ref for data to avoid stale closures ---
  const recordingData = useRef<{startedAt: Date | null, locs: Location.LocationObject[]}>({ startedAt: null, locs: [] });
  const [locCount, setLocCount] = useState(0); // Just for UI display
  const [locSub, setLocSub] = useState<Location.LocationSubscription | null>(null);

  useEffect(() => {
    if (!camPermission?.granted) requestCamPermission();
    if (!micPermission?.granted) requestMicPermission();
    Location.requestForegroundPermissionsAsync();
  }, [camPermission, micPermission]);

  useEffect(() => {
    let interval: any;
    if (isRecording) {
      interval = setInterval(() => {
        if (recordingData.current.startedAt) {
            setTimer(Math.floor((Date.now() - recordingData.current.startedAt.getTime()) / 1000));
        }
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [isRecording]);

  const startRecording = async () => {
    try {
      if (!cameraRef.current) return;
      if (!camPermission?.granted || !micPermission?.granted) {
        setStatusMsg('Missing Perms');
        requestCamPermission();
        requestMicPermission();
        return;
      }
      
      let devId = auth.deviceId;
      if (!devId) {
         const res = await API.request('/devices/register', {
            method: 'POST',
             body: JSON.stringify({ platform: Platform.OS, model: Device.modelName, os_version: Device.osVersion, app_version: '0.1.0' })
         }, auth);
         const d = await res.json();
         devId = d.id;
         auth.setAuth({...auth, deviceId: devId});
      }

      // Reset Data
      recordingData.current = { startedAt: new Date(), locs: [] };
      setLocCount(0);

      const sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 0 },
        (loc) => {
            // Push to Ref (Always fresh)
            recordingData.current.locs.push(loc);
            // Update UI
            setLocCount(recordingData.current.locs.length);
        }
      );
      setLocSub(sub);
      
      setIsRecording(true);
      setStatusMsg('Recording...');
      
      const promise = cameraRef.current.recordAsync({ maxDuration: 7200 });
      promise
        .then((res) => { if(res) finishRecording(res.uri, devId!); })
        .catch(e => { console.error(e); setIsRecording(false); setStatusMsg('Camera Error'); });
        
    } catch (e) {
      setStatusMsg('Failed to start');
      setIsRecording(false);
    }
  };

  const stopRecording = () => {
    if (cameraRef.current && isRecording) {
      cameraRef.current.stopRecording();
    }
  };

  const finishRecording = async (uri: string, devId: string) => {
    setIsRecording(false);
    if (locSub) locSub.remove();
    setStatusMsg('Uploading...');
    
    try {
      // Check Ref for data (It will be correct now)
      const startedAt = recordingData.current.startedAt;
      const locations = recordingData.current.locs;

      if (!startedAt) throw new Error("Start time missing");

      const fileInfo = await FileSystem.getInfoAsync(uri, { size: true });
      if (!fileInfo.exists) throw new Error("File not found");
      
      const startIso = startedAt.toISOString();
      const tripRes = await API.request('/trips', { method: 'POST', body: JSON.stringify({ device_id: devId, start_time_utc: startIso }) }, auth);
      const trip = await tripRes.json();

      const segRes = await API.request(`/trips/${trip.id}/segments`, {
         method: 'POST',
         body: JSON.stringify({ index: 0, video_codec: 'h264', expected_bytes: fileInfo.size, width: 1920, height: 1080, fps: 30 })
      }, auth);
      const segment = await segRes.json();

      // Upload natively using expo-file-system.uploadAsync to avoid loading the file into JS memory.
      const uploadUrl = `${auth.serverUrl.replace(/\/$/, '')}/uploads/multipart`;
      console.log('[Uploader] Preparing native upload', { uploadUrl, uri });
      console.log('[Uploader] fileInfo:', fileInfo);
      let uploadResult;
      try {
        uploadResult = await FileSystem.uploadAsync(uploadUrl, uri, {
          httpMethod: 'POST',
          uploadType: FileSystem.FileSystemUploadType.MULTIPART,
          fieldName: 'file',
          headers: { Authorization: `Bearer ${auth.token}` },
          parameters: {
            trip_id: String(trip.id),
            segment_id: String(segment.id),
            filename: 'seg.mp4',
            file_type: 'video_mp4',
          },
        });
        console.log('[Uploader] uploadAsync finished', { status: uploadResult.status, headers: uploadResult.headers });
      } catch (uploadErr) {
        console.error('[Uploader] uploadAsync threw', uploadErr);
        throw uploadErr;
      }

      // uploadResult.status, uploadResult.body (string), uploadResult.headers
      if (uploadResult.status < 200 || uploadResult.status >= 300) {
        console.error('[Uploader] upload failed response', { status: uploadResult.status, body: uploadResult.body });
        throw new Error(`Upload failed: ${uploadResult.status} ${uploadResult.body}`);
      }

      // Server returns JSON with computed sha and size; parse it
      let uploadJson = {} as any;
      try { uploadJson = JSON.parse(uploadResult.body || '{}'); } catch (e) { console.warn('[Uploader] failed to parse upload body', e); }

      const returnedSize = uploadJson.size ?? (await FileSystem.getInfoAsync(uri, { size: true })).size;
      const returnedSha = uploadJson.sha ?? null;

      await API.request(`/trips/${trip.id}/segments/${segment.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ file_size_bytes: returnedSize, sha256: returnedSha, duration_s: timer, status: 'complete' })
      }, auth);

      const lines = locations.map(l => JSON.stringify({
         ts: new Date(l.timestamp).toISOString(),
         lat: l.coords.latitude,
         lon: l.coords.longitude,
         alt: l.coords.altitude,
         spd: l.coords.speed
      }));
      await API.request(`/segments/${segment.id}/metadata`, {
         method: 'POST',
         body: JSON.stringify({ type: 'gps_jsonl', content: lines.join('\n'), filename: 'gps.jsonl' })
      }, auth);

      await API.request(`/trips/${trip.id}`, {
         method: 'PATCH',
         body: JSON.stringify({ end_time_utc: new Date().toISOString(), duration_s: timer, status: 'complete' })
      }, auth);

      setStatusMsg('Success!');
      setTimer(0);
      setLocCount(0);
      
    } catch (e) {
       setStatusMsg('Upload Failed: ' + (e instanceof Error ? e.message : String(e)));
       console.error(e);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.headerRow}>
         <Text style={styles.headerTitle}>Recorder</Text>
         <Button title="History" onPress={() => navigation.navigate('History')} />
      </View>
      
      <View style={styles.cameraContainer}>
         <CameraView ref={cameraRef} style={styles.camera} facing="back" mode="video" />
      </View>
      
      <View style={styles.hud}>
         <Text style={styles.timerText}>{new Date(timer * 1000).toISOString().substring(11, 19)}</Text>
         <Text>GPS Points: {locCount}</Text>
         <Text style={styles.statusText}>{statusMsg}</Text>
      </View>
      
      <View style={styles.controls}>
        <Button 
          title={isRecording ? "STOP RECORDING" : "START RECORDING"} 
          onPress={isRecording ? stopRecording : startRecording}
          color={isRecording ? "red" : "#007AFF"}
        />
      </View>
    </SafeAreaView>
  );
};

const HistoryScreen: React.FC<any> = ({ navigation }) => {
  const auth = useAuth();
  const [trips, setTrips] = useState<TripSummary[]>([]);

  useEffect(() => {
     const load = async () => {
       try {
         const res = await API.request('/trips', {}, auth);
         const json = await res.json();
         setTrips(json.trips || []);
       } catch (e) { console.error(e); }
     };
     load();
  }, []);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.headerRow}>
        <Button title="Back" onPress={() => navigation.goBack()} />
        <Text style={styles.headerTitle}>History</Text>
      </View>
      <ScrollView style={styles.content}>
         {trips.map(t => (
            <View key={t.id} style={styles.card}>
               <Text style={styles.cardTitle}>{new Date(t.start_time_utc).toLocaleString()}</Text>
               <Text>Status: {t.status}</Text>
               <Text>Files: {t.segments.length}</Text>
            </View>
         ))}
      </ScrollView>
    </SafeAreaView>
  );
};

// --- ROOT ---
const App: React.FC = () => {
  const [auth, setAuth] = useState<AuthState>({ token: null, serverUrl: '' });
  const authCtx = useMemo(() => ({ ...auth, setAuth }), [auth]);

  return (
    <SafeAreaProvider>
        <AuthContext.Provider value={authCtx}>
        <NavigationContainer>
            <Stack.Navigator screenOptions={{ headerShown: false }}>
            {!auth.token ? (
                <Stack.Screen name="Login" component={LoginScreen} />
            ) : (
                <>
                <Stack.Screen name="Recorder" component={RecorderScreen} />
                <Stack.Screen name="History" component={HistoryScreen} />
                </>
            )}
            </Stack.Navigator>
        </NavigationContainer>
        </AuthContext.Provider>
    </SafeAreaProvider>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F2F2F7' },
  content: { padding: 20, flex: 1 },
  header: { fontSize: 28, fontWeight: 'bold', marginBottom: 30, textAlign: 'center', marginTop: 20 },
  label: { fontSize: 16, marginBottom: 5, color: '#333' },
  input: { backgroundColor: 'white', padding: 12, borderRadius: 8, marginBottom: 15, borderWidth: 1, borderColor: '#ddd' },
  spacer: { height: 20 },
  errorText: { color: 'red', textAlign: 'center', marginTop: 20 },
  cameraContainer: { flex: 1, backgroundColor: 'black', margin: 10, borderRadius: 12, overflow: 'hidden' },
  camera: { flex: 1 },
  hud: { padding: 15, alignItems: 'center', backgroundColor: 'white' },
  timerText: { fontSize: 32, fontWeight: 'bold', fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' },
  statusText: { marginTop: 5, color: '#666' },
  controls: { padding: 20, paddingBottom: 40 },
  headerRow: { flexDirection: 'row', alignItems: 'center', padding: 15, backgroundColor: 'white', borderBottomWidth: 1, borderColor: '#eee' },
  headerTitle: { fontSize: 18, fontWeight: 'bold', flex: 1, textAlign: 'center', marginRight: 40 },
  card: { backgroundColor: 'white', padding: 15, marginBottom: 10, borderRadius: 8 },
  cardTitle: { fontWeight: 'bold', marginBottom: 5 }
});

export default App;