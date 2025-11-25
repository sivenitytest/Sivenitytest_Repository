import React, { useState, useEffect, useCallback } from 'react';

// --- Firebase Imports (Must use CDN paths in this environment) ---
// Note: In a typical setup, these would be 'firebase/app', 'firebase/auth', etc.
// For this single-file environment, we assume these are globally available or imported 
// via a custom setup, but we define them here as standard imports for clarity.
import { initializeApp } from 'firebase/app';
import { 
    getAuth, 
    signInAnonymously, 
    signInWithCustomToken, 
    onAuthStateChanged 
} from 'firebase/auth';
import { 
    getFirestore, 
    doc, 
    setDoc, 
    collection, 
    query, 
    where, 
    onSnapshot, 
    getDocs, 
    getDoc,
    addDoc,
    deleteDoc
} from 'firebase/firestore';

// --- Global Variables (Provided by Canvas Environment) ---
// --- Firebase Config (Correctly loaded from .env using Vite's import.meta.env) ---
const firebaseConfig = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
};
const appId = import.meta.env.VITE_FIREBASE_APP_ID; 
// For standard Vite/React development, we assume no initial token
const initialAuthToken = null; 

// The base URL for the Gemini API
const GEMINI_API_URL_BASE = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=`;
// Load the Gemini API key from the environment file for security
const API_KEY = import.meta.env.VITE_GEMINI_API_KEY;

// Utility to implement exponential backoff for API calls
const withRetry = async (fn, maxRetries = 5) => {
    let delay = 1000;
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn();
        } catch (error) {
            if (i === maxRetries - 1) throw error;
            console.warn(`Attempt ${i + 1} failed. Retrying in ${delay}ms...`, error);
            await new Promise(resolve => setTimeout(resolve, delay));
            delay *= 2;
        }
    }
};

// --- Firebase/Auth/DB Setup State Caching (To prevent re-initialization) ---
let dbInstance = null;
let authInstance = null;

const App = () => {
    // --- Firebase State ---
    const [db, setDb] = useState(null);
    const [auth, setAuth] = useState(null);
    const [userId, setUserId] = useState(null);
    const [isAuthReady, setIsAuthReady] = useState(false);
    const [error, setError] = useState(null);

    // --- Application State ---
    const [currentView, setCurrentView] = useState('home'); // 'home', 'modules', 'module', 'topic'
    const [courseName, setCourseName] = useState('Full Stack Java'); // User input for new course
    const [course, setCourse] = useState(null); // The current course object (from Firestore)
    const [modules, setModules] = useState([]); // List of modules for the current course
    const [isLoading, setIsLoading] = useState(false); // General loading state
    const [activeModule, setActiveModule] = useState(null); // The currently viewed module object
    const [topics, setTopics] = useState([]); // Topics for the active module
    const [activeTopic, setActiveTopic] = useState(null); // The currently viewed topic object
    const [selectedTab, setSelectedTab] = useState('content'); // 'content', 'mcqs', 'lab'
    const [mcqs, setMcqs] = useState([]);
    const [lab, setLab] = useState(null);


    // --- 1. FIREBASE INITIALIZATION AND AUTHENTICATION ---
    useEffect(() => {
        try {
            if (!dbInstance) {
                const firebaseApp = initializeApp(firebaseConfig);
                dbInstance = getFirestore(firebaseApp);
                authInstance = getAuth(firebaseApp);
                setDb(dbInstance);
                setAuth(authInstance);
            }
        } catch (e) {
            console.error("Firebase initialization failed:", e);
            setError("Firebase initialization failed. Check console for details.");
            setIsAuthReady(true);
            return;
        }

        if (!authInstance) return;

        const unsubscribe = onAuthStateChanged(authInstance, async (user) => {
            if (user) {
                setUserId(user.uid);
            } else {
                try {
                    // Sign in anonymously if no token, otherwise use the provided custom token
                    if (initialAuthToken) {
                        const credential = await signInWithCustomToken(authInstance, initialAuthToken);
                        setUserId(credential.user.uid);
                    } else {
                        const credential = await signInAnonymously(authInstance);
                        setUserId(credential.user.uid);
                    }
                } catch (e) {
                    console.error("Anonymous or Custom Token sign-in failed:", e);
                    // Fallback to random ID if auth fails completely
                    setUserId(`guest-${crypto.randomUUID()}`);
                }
            }
            setIsAuthReady(true);
        });

        return () => unsubscribe();
    }, []);

    // --- Firestore Path Helper ---
    const getCollectionPath = (collectionName, isPublic = false) => {
        if (!userId) return null;
        if (isPublic) {
            // Public path: /artifacts/{appId}/public/data/{collectionName}
            return `artifacts/${appId}/public/data/${collectionName}`;
        } else {
            // Private path: /artifacts/{appId}/users/{userId}/{collectionName}
            return `artifacts/${appId}/users/${userId}/${collectionName}`;
        }
    };

    // --- 2. DATA FETCHING (Courses, Modules, Topics) ---

    // Fetch the current course state (assuming one course per user for MVP)
    useEffect(() => {
        if (!isAuthReady || !db || !userId) return;

        const coursesCollectionPath = getCollectionPath('courses', false);
        if (!coursesCollectionPath) return;

        // Query for the single course document owned by the user
        const courseQuery = query(collection(db, coursesCollectionPath));

        const unsubscribe = onSnapshot(courseQuery, (snapshot) => {
            if (!snapshot.empty) {
                const courseDoc = snapshot.docs[0];
                const data = courseDoc.data();
                setCourse({ id: courseDoc.id, ...data });
                
                // If course exists, navigate to the modules view
                setCurrentView('modules');
            } else {
                setCourse(null);
                setCurrentView('home');
            }
        }, (err) => {
            console.error("Firestore error fetching course:", err);
            setError("Failed to load course data.");
        });

        return () => unsubscribe();
    }, [isAuthReady, db, userId]);

    // Fetch modules when the course is set
    useEffect(() => {
        if (!isAuthReady || !db || !userId || !course) return;

        const modulesCollectionPath = getCollectionPath('modules', false);
        if (!modulesCollectionPath) return;

        const modulesQuery = query(collection(db, modulesCollectionPath), where('courseId', '==', course.id));

        const unsubscribe = onSnapshot(modulesQuery, (snapshot) => {
            const moduleList = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            setModules(moduleList.sort((a, b) => a.order - b.order));
            
            // If we are in the 'module' view and there's a course, check if we need to load active module
            if ((currentView === 'module' || currentView === 'topic') && activeModule) {
                const updatedActive = moduleList.find(m => m.id === activeModule.id);
                if (updatedActive) {
                    setActiveModule(updatedActive);
                }
            }

        }, (err) => {
            console.error("Firestore error fetching modules:", err);
        });

        return () => unsubscribe();
    }, [isAuthReady, db, userId, course, currentView, activeModule]);

    // Fetch topics when the active module is set
    useEffect(() => {
        if (!isAuthReady || !db || !userId || !activeModule) return;

        const topicsCollectionPath = getCollectionPath('topics', false);
        if (!topicsCollectionPath) return;

        const topicsQuery = query(collection(db, topicsCollectionPath), where('moduleId', '==', activeModule.id));

        const unsubscribe = onSnapshot(topicsQuery, (snapshot) => {
            const topicList = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            setTopics(topicList.sort((a, b) => a.order - b.order));
        }, (err) => {
            console.error("Firestore error fetching topics:", err);
        });

        return () => unsubscribe();
    }, [isAuthReady, db, userId, activeModule]);

    // Fetch assets (MCQs/Lab) when the active topic is set
    useEffect(() => {
        if (!isAuthReady || !db || !userId || !activeTopic) {
            setMcqs([]);
            setLab(null);
            return;
        }

        const assetsCollectionPath = getCollectionPath('assets', false);
        if (!assetsCollectionPath) return;

        // Use onSnapshot for real-time updates of assets
        const mcqQuery = query(collection(db, assetsCollectionPath), 
            where('topicId', '==', activeTopic.id), 
            where('type', '==', 'mcq')
        );
        const labQuery = query(collection(db, assetsCollectionPath), 
            where('topicId', '==', activeTopic.id), 
            where('type', '==', 'lab')
        );

        const unsubscribeMcqs = onSnapshot(mcqQuery, (snapshot) => {
            setMcqs(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
        }, (err) => {
            console.error("Firestore error fetching MCQs:", err);
        });

        const unsubscribeLab = onSnapshot(labQuery, (snapshot) => {
            if (!snapshot.empty) {
                setLab({ id: snapshot.docs[0].id, ...snapshot.docs[0].data() });
            } else {
                setLab(null);
            }
        }, (err) => {
            console.error("Firestore error fetching Lab:", err);
        });

        return () => {
            unsubscribeMcqs();
            unsubscribeLab();
        };

    }, [isAuthReady, db, userId, activeTopic]);


    // --- 3. EVENT HANDLERS / API LOGIC ---

    // **FIX** Handler for course name input change - fixes the unresponsive input
    const handleCourseNameChange = (e) => {
        setCourseName(e.target.value);
    };

    // Handle navigation to a specific module
    const handleViewModule = (moduleData) => {
        setActiveModule(moduleData);
        setCurrentView('module');
        setActiveTopic(null); // Clear active topic when changing modules
        setTopics([]);
        setSelectedTab('content'); // Default to content tab
    };
    
    // Handle navigation back to modules list
    const handleViewModulesList = () => {
        setCurrentView('modules');
        setActiveModule(null);
        setActiveTopic(null);
    }
    
    // Handle navigation to a specific topic
    const handleViewTopic = (topicData) => {
        setActiveTopic(topicData);
        setCurrentView('topic');
        setSelectedTab('content'); // Default to content tab
    };

    // Helper for making API calls
    const callGeminiApi = async (systemPrompt, userQuery, isJson = true) => {
        const url = `${GEMINI_API_URL_BASE}${API_KEY}`;
        const headers = { 'Content-Type': 'application/json' };

        const payload = {
            contents: [{ parts: [{ text: userQuery }] }],
            tools: [{ "google_search": {} }], // Use grounding for up-to-date info
            systemInstruction: {
                parts: [{ text: systemPrompt }]
            },
        };
        
        if (isJson) {
            // Define schema for structured output
            payload.generationConfig = {
                responseMimeType: "application/json",
                responseSchema: {
                    type: "ARRAY",
                    items: {
                        type: "OBJECT",
                        properties: {
                            "title": { "type": "STRING" },
                            "objective": { "type": "STRING" },
                            "topic_title": { "type": "STRING" }, 
                            "content_draft": { "type": "STRING" }, 
                            "question": { "type": "STRING" }, 
                            "options": { "type": "ARRAY", "items": { "type": "STRING" } }, 
                            "correct_answer_index": { "type": "NUMBER" }, 
                            "problemStatement": { "type": "STRING" }, // For Lab
                            "steps": { "type": "ARRAY", "items": { "type": "STRING" } }, // For Lab
                            "expectedOutcome": { "type": "STRING" } // For Lab
                        }
                    }
                }
            };
            
            // For Prompt 4 (Lab), we expect a single JSON object, not an array of objects.
            // We adjust the prompt system prompt to request a single object, 
            // but the schema must accommodate the full range of properties.
            if (systemPrompt.includes("single JSON object")) {
                 payload.generationConfig.responseSchema = {
                    type: "OBJECT",
                    properties: {
                        "problemStatement": { "type": "STRING" },
                        "steps": { "type": "ARRAY", "items": { "type": "STRING" } },
                        "expectedOutcome": { "type": "STRING" }
                    }
                }
            }
        }

        const response = await fetch(url, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`API call failed with status ${response.status}: ${errorText}`);
        }

        const result = await response.json();
        const candidate = result.candidates?.[0];

        if (candidate && candidate.content?.parts?.[0]?.text) {
            const rawText = candidate.content.parts[0].text.trim();
            try {
                // If expecting JSON, parse it
                if (isJson) {
                    return JSON.parse(rawText);
                }
                // Otherwise, return plain text
                return rawText;
            } catch (e) {
                console.error("Failed to parse JSON response:", rawText);
                throw new Error("Received invalid JSON response from AI. Raw response: " + rawText);
            }
        } else {
            throw new Error("AI did not return content.");
        }
    };

    // **FIX** Prompt 1: Generate Course Modules and save to Firestore
    const handleGenerateCourse = async () => {
        if (!db || !courseName || !courseName.trim()) return;

        setIsLoading(true);
        setError(null);
        
        try {
            // 1. Generate 8 Modules (Prompt 1)
            const systemPrompt = "You are a senior curriculum designer. Generate a comprehensive course structure for a specified course aimed at entry-level IT professionals. The output must be structured into 8 distinct modules. Respond only with a JSON array object containing 'title' and 'objective' for each module.";
            const userQuery = `Generate a course structure for a ${courseName} course.`;
            
            const generatedModulesData = await withRetry(() => 
                callGeminiApi(systemPrompt, userQuery, true)
            );

            if (!Array.isArray(generatedModulesData) || generatedModulesData.length === 0) {
                throw new Error("AI failed to generate module structure.");
            }

            // 2. Save Course and Modules to Firestore
            const coursesCollection = collection(db, getCollectionPath('courses', false));
            const modulesCollection = collection(db, getCollectionPath('modules', false));
            const topicsCollection = collection(db, getCollectionPath('topics', false));
            const assetsCollection = collection(db, getCollectionPath('assets', false));
            
            // --- Clean up old data before starting a new course ---
            // Fetch and delete all existing courses for the user (assuming 1 course max)
            const existingCoursesSnapshot = await getDocs(query(coursesCollection));
            for (const doc of existingCoursesSnapshot.docs) {
                await deleteDoc(doc.ref);
            }
            // Note: In a real environment, you'd delete associated modules/topics/assets
            // manually or via database rules, but for this MVP, we rely on the
            // onSnapshot listener to reset the view after the main course doc is deleted.
            // --- End cleanup ---

            // Create new Course
            const newCourseRef = await addDoc(coursesCollection, {
                title: courseName,
                status: 'draft',
                createdAt: new Date(),
                userId: userId,
            });
            const newCourseId = newCourseRef.id;

            // 3. Process Modules and Pre-generate Topics (Prompt 2)
            for (let i = 0; i < generatedModulesData.length; i++) {
                const moduleData = generatedModulesData[i];
                
                // Save Module
                const newModuleRef = await addDoc(modulesCollection, {
                    courseId: newCourseId,
                    title: moduleData.title,
                    objective: moduleData.objective,
                    order: i + 1,
                    createdAt: new Date(),
                });
                
                // Prompt 2: Pre-generate Topics
                const topicSystemPrompt = "For the module and course specified, generate 5 essential, progressive learning topics. For each topic, provide a 'topic_title' and draft the core theoretical content ('content_draft', approx. 200 words) as the lesson material. Respond only with a JSON array object.";
                const topicUserQuery = `Generate 5 topics for the module '${moduleData.title}' within the course '${courseName}'.`;

                const generatedTopicsData = await withRetry(() => 
                    callGeminiApi(topicSystemPrompt, topicUserQuery, true)
                );

                if (Array.isArray(generatedTopicsData)) {
                    for (let j = 0; j < generatedTopicsData.length; j++) {
                        const topic = generatedTopicsData[j];
                        await addDoc(topicsCollection, {
                            moduleId: newModuleRef.id,
                            title: topic.topic_title || `Topic ${j + 1}`,
                            content: topic.content_draft || 'Content draft pending.',
                            order: j + 1,
                            createdAt: new Date(),
                        });
                    }
                }
            }

            // The useEffect on course state handles the navigation to 'modules' view

        } catch (e) {
            console.error("Course Generation Error:", e);
            setError(e.message || "An unexpected error occurred during course generation.");
        } finally {
            setIsLoading(false);
        }
    };
    
    // Prompt 3: Generate MCQs
    const handleGenerateMCQs = async () => {
        if (!db || !activeTopic) return;
        
        setIsLoading(true);
        setError(null);
        
        try {
            // Prompt 3: Generate 5 MCQs
            const systemPrompt = "Based only on the provided content, generate 5 multiple-choice questions (MCQs) suitable for a beginner assessment. Each question must have 4 options and clearly identify the correct answer using a 0-indexed integer for 'correct_answer_index'. Respond only with a JSON array object containing 'question', 'options' (array of 4 strings), and 'correct_answer_index'.";
            const userQuery = `Topic: ${activeTopic.title}\nContent: ${activeTopic.content}`;

            const generatedMCQsData = await withRetry(() => 
                callGeminiApi(systemPrompt, userQuery, true)
            );
            
            if (!Array.isArray(generatedMCQsData) || generatedMCQsData.length === 0) {
                throw new Error("AI failed to generate MCQs.");
            }

            // Save MCQs to Firestore
            const assetsCollection = collection(db, getCollectionPath('assets', false));
            
            // Delete existing MCQs for this topic (for clean regeneration)
            const existingMcqs = mcqs.map(m => doc(assetsCollection, m.id));
            for (const docRef of existingMcqs) {
                await deleteDoc(docRef);
            }
            
            for (const mcq of generatedMCQsData) {
                await addDoc(assetsCollection, {
                    topicId: activeTopic.id,
                    type: 'mcq',
                    question: mcq.question,
                    options: mcq.options,
                    // Ensure the index is a number
                    correctIndex: Number(mcq.correct_answer_index) || 0,
                    createdAt: new Date(),
                });
            }
            
            setSelectedTab('mcqs'); // Switch to the MCQs tab

        } catch (e) {
            console.error("MCQ Generation Error:", e);
            setError(e.message || "An unexpected error occurred during MCQ generation.");
        } finally {
            setIsLoading(false);
        }
    };
    
    // Prompt 4: Generate Lab Instructions
    const handleGenerateLab = async () => {
        if (!db || !activeTopic) return;
        
        setIsLoading(true);
        setError(null);
        
        try {
            // Prompt 4: Generate Lab Instructions
            const systemPrompt = "Design one concise practice exercise or Lab Instruction suitable for a developer based on the content. The output should be a single JSON object containing three fields: 'problemStatement' (short User Story), 'steps' (an array of 3-5 technical steps), and 'expectedOutcome' (a clear final result description). Respond only with a single JSON object.";
            const userQuery = `Topic: ${activeTopic.title}\nContent: ${activeTopic.content}`;

            const generatedLabData = await withRetry(() => 
                callGeminiApi(systemPrompt, userQuery, true) // isJson is true, schema is handled inside callGeminiApi
            );
            
            if (!generatedLabData || !generatedLabData.problemStatement) {
                throw new Error("AI failed to generate lab instructions.");
            }

            // Save Lab to Firestore
            const assetsCollection = collection(db, getCollectionPath('assets', false));
            
            // Delete existing Lab for this topic (for clean regeneration)
            if (lab) {
                await deleteDoc(doc(assetsCollection, lab.id));
            }
            
            await addDoc(assetsCollection, {
                topicId: activeTopic.id,
                type: 'lab',
                title: `${activeTopic.title} Practice Lab`,
                problemStatement: generatedLabData.problemStatement,
                steps: generatedLabData.steps,
                expectedOutcome: generatedLabData.expectedOutcome,
                createdAt: new Date(),
            });
            
            setSelectedTab('lab'); // Switch to the Lab tab

        } catch (e) {
            console.error("Lab Generation Error:", e);
            setError(e.message || "An unexpected error occurred during lab generation.");
        } finally {
            setIsLoading(false);
        }
    };

    // --- 4. UI COMPONENTS ---

    // Generic Button Component for styling
    const Button = ({ children, onClick, disabled = false, className = '' }) => (
        <button
            onClick={onClick}
            disabled={disabled || isLoading}
            className={`w-full py-3 px-6 rounded-xl font-semibold transition duration-300 transform 
                        ${disabled || isLoading
                            ? 'bg-gray-400 text-gray-700 cursor-not-allowed'
                            : 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-lg hover:scale-[1.01] active:scale-[0.99]'
                        } ${className}`}
        >
            {isLoading ? (
                <div className="flex items-center justify-center space-x-2">
                    <svg className="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    <span>Generating...</span>
                </div>
            ) : children}
        </button>
    );

    // 4.1 Home View: Course Name Input
    const HomeView = () => (
        <div className="p-8 space-y-8 bg-white rounded-2xl shadow-2xl">
            <h1 className="text-4xl font-extrabold text-indigo-800">AI Course Designer</h1>
            <p className="text-xl text-gray-600">Define your course and generate the initial 8-module structure.</p>

            <div className="space-y-4">
                <label htmlFor="courseName" className="block text-sm font-medium text-gray-700">Course Name</label>
                <input
                    type="text"
                    id="courseName"
                    value={courseName}
                    // **FIX**: Correctly binding the onChange handler
                    onChange={handleCourseNameChange}
                    placeholder="e.g., Full Stack Java, Advanced Data Science"
                    className="w-full p-4 border border-gray-300 rounded-xl focus:ring-indigo-500 focus:border-indigo-500 text-lg shadow-inner"
                    disabled={isLoading}
                />
            </div>
            
            <Button 
                // **FIX**: Correctly binding the onClick handler
                onClick={handleGenerateCourse} 
                disabled={!courseName.trim() || isLoading}
            >
                Generate Course Modules (8 Modules)
            </Button>
            
            {error && <div className="p-4 text-red-700 bg-red-100 rounded-lg border border-red-300 text-sm">{error}</div>}
        </div>
    );

    // 4.2 Modules List View
    const ModulesView = () => (
        <div className="space-y-6">
            <h1 className="text-4xl font-extrabold text-indigo-800 border-b pb-2">
                <span className="text-2xl font-light text-gray-500 mr-2">Course:</span>
                {course.title}
            </h1>
            <p className="text-lg text-gray-600">
                The AI generated 8 core modules. Click to view topics and content for each module.
            </p>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {modules.map((module, index) => (
                    <div 
                        key={module.id} 
                        className="p-6 bg-white rounded-2xl shadow-lg border border-gray-100 hover:shadow-xl transition duration-300 cursor-pointer"
                        onClick={() => handleViewModule(module)}
                    >
                        <h2 className="text-xl font-bold text-indigo-700 mb-2">
                            Module {index + 1}: {module.title}
                        </h2>
                        <p className="text-gray-600 text-sm italic">{module.objective}</p>
                        <div className="mt-4 text-sm font-semibold text-indigo-500 hover:text-indigo-600">
                            View Topics →
                        </div>
                    </div>
                ))}
            </div>
            
             <Button 
                onClick={handleGenerateCourse} 
                className="mt-6"
                disabled={isLoading}
            >
                {isLoading ? 'Regenerating Course...' : 'Regenerate Course (Warning: This will overwrite current data)'}
            </Button>
        </div>
    );

    // 4.3 Module Detail View (Topics List)
    const ModuleDetailView = () => (
        <div className="space-y-6">
            <button 
                onClick={handleViewModulesList} 
                className="text-indigo-600 hover:text-indigo-800 font-medium flex items-center mb-4 text-sm"
            >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-1" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
                Back to Modules
            </button>
            
            <h1 className="text-3xl font-extrabold text-gray-800 border-b pb-2">
                <span className="text-xl font-light text-indigo-500 mr-2">Module:</span>
                {activeModule.title}
            </h1>
            <p className="text-lg text-gray-600 italic">{activeModule.objective}</p>
            
            <h2 className="text-2xl font-bold text-gray-700 mt-8 mb-4">Topics ({topics.length})</h2>
            
            <div className="space-y-4">
                {topics.length > 0 ? topics.map((topic, index) => (
                    <div 
                        key={topic.id} 
                        className="p-5 bg-white rounded-xl shadow-md hover:shadow-lg transition duration-300 border-l-4 border-indigo-400 cursor-pointer"
                        onClick={() => handleViewTopic(topic)}
                    >
                        <h3 className="text-xl font-semibold text-gray-800">
                            {activeModule.order}.{index + 1}. {topic.title}
                        </h3>
                        <p className="text-sm text-gray-500 mt-2 line-clamp-2">
                            {topic.content.substring(0, 150)}...
                        </p>
                        <div className="mt-3 text-xs font-semibold text-indigo-500 hover:text-indigo-600">
                            View Topic Content & Assets →
                        </div>
                    </div>
                )) : (
                    <div className="p-8 text-center text-gray-500 bg-gray-50 rounded-xl">
                        Loading topics...
                    </div>
                )}
            </div>
        </div>
    );

    // 4.4 Topic Detail View (Content and Assets)
    const TopicDetailView = () => (
        <div className="space-y-6">
            <button 
                onClick={() => handleViewModule(activeModule)} 
                className="text-indigo-600 hover:text-indigo-800 font-medium flex items-center mb-4 text-sm"
            >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-1" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
                Back to {activeModule.title} Topics
            </button>
            
            <h1 className="text-3xl font-extrabold text-gray-800 border-b pb-2">
                <span className="text-xl font-light text-indigo-500 mr-2">Topic:</span>
                {activeTopic.title}
            </h1>

            {/* Tabs Navigation */}
            <div className="border-b border-gray-200">
                <nav className="-mb-px flex space-x-8" aria-label="Tabs">
                    {['content', 'mcqs', 'lab'].map((tab) => (
                        <button
                            key={tab}
                            onClick={() => setSelectedTab(tab)}
                            className={`whitespace-nowrap py-3 px-1 border-b-2 font-medium text-sm transition duration-150 ease-in-out ${
                                selectedTab === tab
                                    ? 'border-indigo-500 text-indigo-600'
                                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                            }`}
                        >
                            {tab === 'content' && 'Content Draft'}
                            {tab === 'mcqs' && `MCQs (${mcqs.length})`}
                            {tab === 'lab' && (lab ? 'Practice Lab (Generated)' : 'Practice Lab (Draft)')}
                        </button>
                    ))}
                </nav>
            </div>

            {/* Tab Content */}
            <div className="bg-white p-6 rounded-xl shadow-lg min-h-[300px]">
                {selectedTab === 'content' && (
                    <div className="space-y-4">
                        <h2 className="text-2xl font-semibold text-gray-700">Theoretical Content Draft</h2>
                        <p className="text-gray-600 whitespace-pre-wrap">{activeTopic.content}</p>
                    </div>
                )}
                
                {selectedTab === 'mcqs' && (
                    <div className="space-y-6">
                        <div className='flex justify-between items-center'>
                            <h2 className="text-2xl font-semibold text-gray-700">Multiple Choice Questions</h2>
                            <Button 
                                onClick={handleGenerateMCQs} 
                                disabled={isLoading}
                                className="!w-auto !py-2 !px-4 !text-sm"
                            >
                                {mcqs.length > 0 ? 'Regenerate MCQs' : 'Generate MCQs'}
                            </Button>
                        </div>
                        {mcqs.length === 0 && !isLoading && (
                             <div className="p-4 text-center text-gray-500 bg-gray-50 rounded-xl">
                                Click 'Generate MCQs' to create assessment questions based on the topic content.
                            </div>
                        )}
                        {mcqs.map((mcq, index) => (
                            <div key={mcq.id} className="p-4 border border-gray-200 rounded-lg bg-gray-50">
                                <p className="font-medium text-gray-800 mb-2">Q{index + 1}: {mcq.question}</p>
                                <ul className="space-y-1 text-sm">
                                    {mcq.options && mcq.options.map((option, optIndex) => (
                                        <li 
                                            key={optIndex} 
                                            className={`p-1 rounded ${mcq.correctIndex === optIndex ? 'bg-green-100 text-green-800 font-semibold' : 'text-gray-600'}`}
                                        >
                                            <span className="font-mono text-xs mr-2 text-indigo-500">{String.fromCharCode(65 + optIndex)}.</span>
                                            {option}
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        ))}
                    </div>
                )}
                
                {selectedTab === 'lab' && (
                    <div className="space-y-6">
                        <div className='flex justify-between items-center'>
                            <h2 className="text-2xl font-semibold text-gray-700">Practice Lab Instructions</h2>
                            <Button 
                                onClick={handleGenerateLab} 
                                disabled={isLoading}
                                className="!w-auto !py-2 !px-4 !text-sm"
                            >
                                {lab ? 'Regenerate Lab' : 'Generate Lab Instructions'}
                            </Button>
                        </div>

                        {lab ? (
                            <div className="space-y-4">
                                <div className="p-4 bg-indigo-50 rounded-lg">
                                    <h3 className="font-bold text-indigo-700 mb-1">Problem Statement/User Story</h3>
                                    <p className="text-gray-800">{lab.problemStatement}</p>
                                </div>

                                <div>
                                    <h3 className="font-bold text-gray-700 mb-2">Steps to Complete the Lab</h3>
                                    <ol className="list-decimal list-inside space-y-2 pl-4">
                                        {lab.steps && Array.isArray(lab.steps) && lab.steps.map((step, index) => (
                                            <li key={index} className="text-gray-600">{step}</li>
                                        ))}
                                    </ol>
                                </div>

                                <div className="p-4 bg-green-50 rounded-lg border border-green-200">
                                    <h3 className="font-bold text-green-700 mb-1">Expected Outcome</h3>
                                    <p className="text-gray-800">{lab.expectedOutcome}</p>
                                </div>
                            </div>
                        ) : !isLoading && (
                            <div className="p-4 text-center text-gray-500 bg-gray-50 rounded-xl">
                                Click 'Generate Lab Instructions' to create a practical exercise based on the topic content.
                            </div>
                        )}
                    </div>
                )}
                
            </div>
            
            {error && <div className="mt-4 p-4 text-red-700 bg-red-100 rounded-lg border border-red-300 text-sm">{error}</div>}

        </div>
    );


    // --- 5. MAIN RENDER LOGIC ---

    // Handle initialization and major errors
    if (error && !isAuthReady) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-gray-50 p-4">
                <div className="p-8 bg-white rounded-xl shadow-2xl max-w-lg text-center">
                    <h1 className="text-2xl font-bold text-red-600 mb-4">Application Error</h1>
                    <p className="text-gray-600">{error}</p>
                    <p className="text-sm text-gray-400 mt-4">Please check the browser console for details.</p>
                </div>
            </div>
        );
    }
    
    // Show a global loading state while Firebase/Auth is setting up
    if (!isAuthReady || !db) {
        return (
            <div className="flex flex-col items-center justify-center min-h-screen bg-gray-50 p-4 space-y-4">
                <svg className="animate-spin h-10 w-10 text-indigo-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                <p className="text-lg text-gray-600">Initializing Application and Authentication...</p>
            </div>
        );
    }
    
    // Main UI structure
    return (
        <div className="min-h-screen bg-gray-50 p-4 sm:p-8 font-sans">
            <script src="https://cdn.tailwindcss.com"></script>
            <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet" />

            <header className="flex justify-between items-center mb-8 pb-4 border-b">
                <div className="flex items-center space-x-2">
                    <svg className="h-6 w-6 text-indigo-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13M18.673 18.552a7.5 7.5 0 00-15.346 0M12 6.253v13M2.28 10.373A12.5 12.5 0 0112 2c5.07 0 9.4 2.164 12.55 6.373M12 6.253V13" />
                    </svg>
                    <span className="text-lg font-bold text-gray-800">AI Course Designer</span>
                </div>
                <div className="text-sm text-gray-500 bg-white p-2 rounded-full shadow-sm">
                    User ID: <span className="font-mono text-xs">{userId || 'Loading...'}</span>
                </div>
            </header>

            <main className="max-w-4xl mx-auto">
                {error && (
                    <div className="mb-4 p-4 text-red-700 bg-red-100 rounded-lg border border-red-300 text-base font-medium">
                        **Error:** {error}
                    </div>
                )}
                
                {/* Routing based on state */}
                {(() => {
                    if (!course && !isLoading) {
                        return <HomeView />;
                    } else if (currentView === 'modules' || (course && !activeModule)) {
                        return <ModulesView />;
                    } else if (currentView === 'module' && activeModule && !activeTopic) {
                        return <ModuleDetailView />;
                    } else if (currentView === 'topic' && activeTopic) {
                        return <TopicDetailView />;
                    }
                    return (
                        <div className="flex flex-col items-center justify-center p-16 space-y-4">
                             <svg className="animate-spin h-10 w-10 text-indigo-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                            </svg>
                            <p className="text-lg text-gray-600">Loading Application State...</p>
                        </div>
                    );
                })()}
            </main>
        </div>
    );
};

export default App;