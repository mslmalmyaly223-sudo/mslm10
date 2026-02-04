// smart-matchmaking.js - نظام مباراة ذكي
import { 
    collection, addDoc, getDocs, doc, updateDoc, onSnapshot, 
    query, where, limit, serverTimestamp, increment, arrayUnion,
    getDoc, writeBatch
} from "https://www.gstatic.com/firebasejs/9.22.0/firebase-firestore.js";

let db;

class SmartMatchmaking {
    constructor(firestoreDb) {
        db = firestoreDb;
        this.currentMatch = null;
        this.matchListeners = {};
        this.reconnectAttempts = 0;
        this.maxReconnect = 3;
    }

    async findMatch(userData, subject, type, mode = 'online') {
        try {
            if (this.currentMatch) {
                this.cancelSearch();
            }

            this.currentMatch = {
                searching: true,
                mode: mode,
                subject: subject,
                type: type,
                userId: userData.uid,
                userData: userData,
                startTime: Date.now()
            };

            this.showSearchUI();

            if (mode === 'online') {
                await this.findOnlineMatch(userData, subject, type);
            } else {
                await this.findAIMatch(userData, subject, type);
            }

        } catch (error) {
            console.error('Matchmaking error:', error);
            this.showError('خطأ في البحث عن مباراة');
            this.reset();
        }
    }

    async findOnlineMatch(userData, subject, type) {
        try {
            // جلب الأسئلة أولاً
            const questions = await this.getQuestions(subject, type, userData.grade);
            if (questions.length < 5) {
                throw new Error('لا توجد أسئلة كافية');
            }

            // البحث عن مباراة في انتظار
            const existingMatch = await this.findExistingMatch(userData, subject, type);
            
            if (existingMatch) {
                await this.joinMatch(existingMatch, userData);
            } else {
                await this.createMatch(userData, subject, type, questions);
            }

        } catch (error) {
            throw error;
        }
    }

    async findExistingMatch(userData, subject, type) {
    const grade = userData.grade;
    let group = `${grade}_${subject}`;
    
    if (['اسلامية', 'عربي', 'انكليزي'].includes(subject) && ['6sci', '6lit'].includes(grade)) {
        group = `6shared_${subject}`;
    }

    try {
        const q = query(
            collection(db, "match_queue"),
            where("group", "==", group),
            where("status", "==", "waiting"),
            where("grade", "==", grade),
            limit(1)
        );

        const snapshot = await getDocs(q);
        
        if (!snapshot.empty) {
            const doc = snapshot.docs[0];
            const data = doc.data();
            
            // تحقق أن اللاعب ليس هو نفسه
            if (data.player1 && data.player1.uid !== userData.uid) {
                return { id: doc.id, data: data };
            }
        }
        
        return null;
    } catch (error) {
        console.error('Error finding existing match:', error);
        return null;
    }
}

    async createMatch(userData, subject, type, questions) {
        const grade = userData.grade;
        let group = `${grade}_${subject}`;
        
        if (['اسلامية', 'عربي', 'انكليزي'].includes(subject) && ['6sci', '6lit'].includes(grade)) {
            group = `6shared_${subject}`;
        }

        // خلط وأخذ 10 أسئلة
        const shuffledQuestions = this.shuffleArray(questions).slice(0, 10);

        const matchData = {
            group: group,
            status: 'waiting',
            player1: {
                uid: userData.uid,
                name: userData.name,
                photo: userData.photo,
                grade: userData.grade,
                score: 0,
                connected: true,
                lastPing: Date.now()
            },
            player2: null,
            questions: shuffledQuestions,
            currentQuestion: 0,
            answers: [],
            subject: subject,
            type: type,
            grade: grade,
            createdAt: serverTimestamp(),
            lastActivity: Date.now(),
            expiresAt: Date.now() + 300000, // 5 دقائق
lastActivity: Date.now()
        };

        const docRef = await addDoc(collection(db, "match_queue"), matchData);
        
        this.currentMatch.id = docRef.id;
        this.currentMatch.isHost = true;
        
        this.listenToMatch(docRef.id);
        this.startMatchTimeout();
    }

    async joinMatch(existingMatch, userData) {
        const matchRef = doc(db, "match_queue", existingMatch.id);
        
        await updateDoc(matchRef, {
            player2: {
                uid: userData.uid,
                name: userData.name,
                photo: userData.photo,
                grade: userData.grade,
                score: 0,
                connected: true,
                lastPing: Date.now()
            },
            status: 'active',
            lastActivity: Date.now()
        });

        this.currentMatch.id = existingMatch.id;
        this.currentMatch.isHost = false;
        
        this.listenToMatch(existingMatch.id);
    }

    listenToMatch(matchId) {
    if (this.matchListeners[matchId]) {
        this.matchListeners[matchId]();
    }

    try {
        const matchRef = doc(db, "match_queue", matchId);
        
        this.matchListeners[matchId] = onSnapshot(matchRef, (snapshot) => {
            if (!snapshot.exists()) {
                this.handleMatchDeleted();
                return;
            }

            const matchData = snapshot.data();
            this.handleMatchUpdate(matchData);
        }, (error) => {
            console.error('Listen error:', error);
            this.handleDisconnection();
        });
    } catch (error) {
        console.error('Error setting up listener:', error);
    }
}

    handleMatchUpdate(matchData) {
        // تحديث نشاط المباراة
        this.updateMatchActivity();
        
        if (matchData.status === 'active' && matchData.player2) {
            this.startGame(matchData);
        } else if (matchData.status === 'completed') {
            this.endGame(matchData);
        } else if (matchData.status === 'cancelled') {
            this.handleMatchCancelled();
        }
    }

    async submitAnswer(answerIndex, answerValue) {
        if (!this.currentMatch?.id) return;

        try {
            const matchRef = doc(db, "match_queue", this.currentMatch.id);
            const matchDoc = await getDoc(matchRef);
            
            if (!matchDoc.exists()) return;

            const matchData = matchDoc.data();
            const isPlayer1 = matchData.player1.uid === this.currentMatch.userId;
            const playerField = isPlayer1 ? 'player1' : 'player2';
            
            // تسجيل الإجابة
            await updateDoc(matchRef, {
                [`${playerField}.lastPing`]: Date.now(),
                lastActivity: Date.now(),
                answers: arrayUnion({
                    playerId: this.currentMatch.userId,
                    questionIndex: matchData.currentQuestion,
                    answer: answerValue,
                    timestamp: Date.now()
                })
            });

            // الانتقال للسؤال التالي
            await this.checkNextQuestion(matchData);

        } catch (error) {
            console.error('Error submitting answer:', error);
            this.handleDisconnection();
        }
    }

    async checkNextQuestion(matchData) {
        const answersCount = matchData.answers?.filter(
            a => a.questionIndex === matchData.currentQuestion
        ).length || 0;

        if (answersCount >= 2) {
            const matchRef = doc(db, "match_queue", this.currentMatch.id);
            const nextIndex = matchData.currentQuestion + 1;
            
            if (nextIndex >= matchData.questions.length) {
                // نهاية المباراة
                await updateDoc(matchRef, {
                    status: 'completed',
                    lastActivity: Date.now()
                });
            } else {
                // الانتقال للسؤال التالي
                setTimeout(async () => {
                    await updateDoc(matchRef, {
                        currentQuestion: nextIndex,
                        lastActivity: Date.now()
                    });
                }, 2000);
            }
        }
    }

    cancelSearch() {
        if (this.currentMatch?.id && this.currentMatch.isHost) {
            const matchRef = doc(db, "match_queue", this.currentMatch.id);
            updateDoc(matchRef, {
                status: 'cancelled',
                lastActivity: Date.now()
            });
        }
        this.reset();
    }

    reset() {
        Object.values(this.matchListeners).forEach(unsubscribe => unsubscribe && unsubscribe());
        this.matchListeners = {};
        this.currentMatch = null;
        this.reconnectAttempts = 0;
        this.hideSearchUI();
        document.getElementById('challenge-active-card')?.classList.remove('hidden');
    }

    handleDisconnection() {
        if (this.reconnectAttempts < this.maxReconnect) {
            this.reconnectAttempts++;
            setTimeout(() => this.reconnect(), 2000 * this.reconnectAttempts);
        } else {
            this.showError('انقطع الاتصال بالمباراة');
            this.reset();
        }
    }

    async reconnect() {
        if (!this.currentMatch?.id) return;

        try {
            const matchRef = doc(db, "match_queue", this.currentMatch.id);
            const matchDoc = await getDoc(matchRef);
            
            if (!matchDoc.exists()) {
                this.handleMatchDeleted();
                return;
            }

            const matchData = matchDoc.data();
            const playerField = matchData.player1.uid === this.currentMatch.userId ? 'player1' : 'player2';
            
            await updateDoc(matchRef, {
                [`${playerField}.connected`]: true,
                [`${playerField}.lastPing`]: Date.now(),
                lastActivity: Date.now()
            });

            this.reconnectAttempts = 0;

        } catch (error) {
            this.handleDisconnection();
        }
    }

    // دوال مساعدة
    async getQuestions(subject, type, grade) {
        let gradeCondition = grade;
        if (['اسلامية', 'عربي', 'انكليزي'].includes(subject) && ['6sci', '6lit'].includes(grade)) {
            gradeCondition = ['6sci', '6lit'];
        }

        const q = Array.isArray(gradeCondition) ?
            query(
                collection(db, "questions"),
                where("grade", "in", gradeCondition),
                where("subject", "==", subject),
                where("type", "==", type),
                limit(30)
            ) :
            query(
                collection(db, "questions"),
                where("grade", "==", gradeCondition),
                where("subject", "==", subject),
                where("type", "==", type),
                limit(30)
            );

        const snap = await getDocs(q);
        return snap.docs.map(d => d.data());
    }

    shuffleArray(array) {
        const newArray = [...array];
        for (let i = newArray.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
        }
        return newArray;
    }

    // واجهة المستخدم
    showSearchUI() {
        const searchUI = document.getElementById('searching-ui');
        if (searchUI) {
            searchUI.classList.remove('hidden');
            searchUI.style.display = 'flex';
        }
        
        const msg = document.getElementById('search-msg');
        if (msg) {
            msg.textContent = 'جاري البحث عن خصم...';
        }
        
        const challengeCard = document.getElementById('challenge-active-card');
        if (challengeCard) {
            challengeCard.classList.add('hidden');
        }
    }

    hideSearchUI() {
        const searchUI = document.getElementById('searching-ui');
        if (searchUI) {
            searchUI.classList.add('hidden');
        }
    }

    startGame(matchData) {
        this.hideSearchUI();
        // هنا ستتكامل مع شاشة اللعبة الحالية
        console.log('بدء اللعبة:', matchData);
        // يمكنك استدعاء renderGame الحالية
        if (window.renderGame) {
            window.renderGame(matchData);
        }
    }

    endGame(matchData) {
        console.log('انتهت المباراة:', matchData);
        this.reset();
        // استدعاء شاشة النتائج الحالية
        if (window.endGame) {
            window.endGame(matchData);
        }
    }

    handleMatchDeleted() {
        this.showError('تم حذف المباراة');
        this.reset();
    }

    handleMatchCancelled() {
        this.showError('تم إلغاء المباراة');
        this.reset();
    }

    showError(message) {
        alert(message); // يمكن استبدالها بـ showBeautifulAlert
    }

    updateMatchActivity() {
        if (this.currentMatch?.id) {
            const matchRef = doc(db, "match_queue", this.currentMatch.id);
            updateDoc(matchRef, {
                lastActivity: Date.now()
            });
        }
    }

    startMatchTimeout() {
        setTimeout(() => {
            if (this.currentMatch?.searching) {
                this.showError('انتهى وقت البحث');
                this.cancelSearch();
            }
        }, 60000); // دقيقة واحدة
    }
}

// تصدير النظام
window.SmartMatchmaking = SmartMatchmaking;
